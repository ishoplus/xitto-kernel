// Kernel 組裝 — 把一個 DomainPack 接上領域無關的執行期。
// 確定性那半部：pack 載入、工具註冊、mutatingTools 推導、固定順序守衛鏈、systemPrompt 組裝、
// 單一工具呼叫（runTool）。LLM 那半部：runTurn 驅動移植自 xitto-code 的 Agent loop
// （串流 + 多步工具循環 + 守衛接線）。壓縮/TUI 仍為後續接縫。
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { loadPack } from './pack-loader.js';
import { createToolRegistry, deriveMutatingTools, isSandboxable } from './tool-registry.js';
import { composeGuards } from './guard-chain.js';
import { createPermissionStep } from './security/permission-step.js';
import { normalizeSandbox, wrapWithSeatbelt } from './security/sandbox.js';
import { createMemory } from './memory.js';
import { createSpawnTool } from './subagent.js';
import { createSkills } from './skills.js';
import { loadHooks, runPreToolHooks, runPostToolHooks } from './hooks.js';
import { maybeCompact, resolveCompactionSettings } from './compaction.js';
import { checkGoal, normalizeFeedback } from './goal-loop.js';
import { newSessionId, saveSession, loadSession, listSessions, latestSession } from './session.js';

// 載入 pack.contextFiles：從 cwd 逐層往上找每個檔名，找到就讀入並注入 system prompt（領域規範）。
// 對標 xitto-code 的 CLAUDE.md/AGENTS.md 載入；但檔名由 pack 決定（kernel 不認識具體檔名）。
function loadContextFiles(cwd, names) {
  if (!Array.isArray(names) || !names.length) return '';
  const found = [];
  for (const name of names) {
    let dir = cwd;
    for (;;) {
      const p = join(dir, name);
      if (existsSync(p)) { try { found.push({ name, text: readFileSync(p, 'utf8') }); } catch { /* 略 */ } break; }
      const parent = dirname(dir);
      if (parent === dir) break; // 到根目錄
      dir = parent;
    }
  }
  if (!found.length) return '';
  return '\n\n# 專案規範（讀自下列檔案，請遵守）\n' +
    found.map((f) => `## ${f.name}\n${f.text.trim()}`).join('\n\n');
}

const DEFAULT_MEMORY_GUIDE =
  '遇到值得跨 session 記住的事實（使用者偏好、建置/測試指令、踩過的坑、專案決策）時，當下就存一條。';

// 把 sandboxable 工具的命令在執行期包進 Seatbelt（macOS OS 級隔離）。
// 非 macOS / 沙箱關閉 / 無 command → wrapWithSeatbelt 回 null，跑原命令（仍受第 5 格靜態策略保護）。
function wrapSandboxable(tool, { cwd, getSandbox, getSandboxConfig }) {
  if (!isSandboxable(tool) || typeof tool.execute !== 'function') return tool;
  const orig = tool.execute.bind(tool);
  return {
    ...tool,
    execute: (id, params, ...rest) => {
      if (getSandbox?.() && params?.command) {
        const wrapped = wrapWithSeatbelt(params.command, { cwd, cfg: getSandboxConfig?.() });
        if (wrapped) params = { ...params, command: wrapped };
      }
      return orig(id, params, ...rest);
    },
  };
}

// undo 快照：mutating 且帶 args.path 的工具（檔案編輯類），執行前記錄檔案原狀，供 kernel.undo() 還原。
// 「以 path 指涉被改檔案」是常見約定；非檔案型 mutating 工具（bash/sql_exec 無 path）不受影響。
function wrapUndo(tool, { cwd, undoStack }) {
  if (tool.mutating !== true || typeof tool.execute !== 'function') return tool;
  const orig = tool.execute.bind(tool);
  return {
    ...tool,
    execute: (id, params, ...rest) => {
      if (params?.path) {
        const p = isAbsolute(params.path) ? params.path : join(cwd, params.path);
        try {
          undoStack.push({ path: p, rel: params.path, before: existsSync(p) ? readFileSync(p, 'utf8') : null });
          if (undoStack.length > 50) undoStack.shift();
        } catch { /* 略 */ }
      }
      return orig(id, params, ...rest);
    },
  };
}

/**
 * 建立 kernel 執行期。
 * @param {import('../types.js').DomainPack} pack
 * @param {Object} [config]
 * @param {string} [config.cwd]
 * @param {() => boolean} [config.getPlanMode]                 計劃模式狀態（預設關）
 * @param {(ctx: object) => import('../types.js').PolicyDecision} [config.circuitBreaker] 上下文熔斷（預設不熔斷）
 * @param {(ctx: object) => import('../types.js').PolicyDecision} [config.preToolHooks]   使用者 PreToolUse hooks（預設無）
 * @param {(name: string, args: object) => Promise<'yes'|'no'>} [config.confirm]          mutating 工具的確認（預設放行）
 * @param {Partial<import('../types.js').KernelServices>} [config.services]
 * @param {object} [config.model]                              LLM model 物件（runTurn 需要）
 * @param {(provider: string) => string|Promise<string>} [config.getApiKey]               取 API key（runTurn 需要）
 * @param {Function} [config.streamFn]                         注入串流（測試用 fake provider）；預設用 pi-ai
 * @param {'off'|'low'|'medium'|'high'} [config.thinkingLevel] 推理強度（預設依 model.reasoning）
 */
export function createKernel(pack, config = {}) {
  loadPack(pack);
  const cwd = config.cwd || process.cwd();

  // 每個 pack 在 cwd 下有獨立資料夾（記憶、session 分領域存放，互不混）
  const dataDir = join(cwd, '.xitto-kernel', pack.name);
  const memory = createMemory(join(dataDir, 'memory.md'));
  const sessionsDir = join(dataDir, 'sessions');
  const hooks = loadHooks(join(dataDir, 'settings.json')); // PreToolUse/PostToolUse
  const skills = createSkills(join(dataDir, 'skills'));     // 漸進揭露技能

  // 沙箱策略：config.sandbox > pack.permissionPolicy.sandbox > 預設（關）。
  const sandboxCfg = normalizeSandbox(config.sandbox ?? pack.permissionPolicy?.sandbox);
  const getSandbox = config.getSandbox || (() => !!sandboxCfg.enabled);
  const getSandboxConfig = () => sandboxCfg;

  // 工具：pack 工具（sandboxable 包 Seatbelt、mutating+path 加 undo 快照）+ kernel 內建記憶工具 + spawn_agent。
  const undoStack = [];
  const baseTools = [
    ...pack.tools().map((t) => wrapUndo(wrapSandboxable(t, { cwd, getSandbox, getSandboxConfig }), { cwd, undoStack })),
    ...memory.tools,
    ...(skills.tool ? [skills.tool] : []),
    ...(config.extraTools || []),  // 外部注入（MCP 工具等）：由 app 層先 async 載入再傳入
  ];
  // spawn_agent：派唯讀子 agent。其可用工具 = 所有唯讀工具（不含 spawn_agent 自己，避免遞迴）。
  let allTools = baseTools;
  const spawnTool = createSpawnTool({
    getModel: () => config.model,
    getApiKey: config.getApiKey,
    getReadOnlyTools: () => allTools.filter((t) => t.readOnly === true && t.name !== 'spawn_agent'),
  });
  const tools = [...baseTools, spawnTool];
  allTools = tools;
  const registry = createToolRegistry(tools);
  const mutatingTools = new Set(deriveMutatingTools(pack, tools));
  const services = {
    cwd,
    memory: { save: memory.save, list: memory.list },
    sandbox: { isOn: () => getSandbox(), config: () => getSandboxConfig() },
    ...(config.services || {}),
  };

  const memText = memory.load();
  const systemPrompt =
    pack.systemPrompt +
    loadContextFiles(cwd, pack.contextFiles) +          // 注入領域規範檔（CLAUDE.md 等）
    '\n\n# 記憶\n' + (pack.memoryGuide || DEFAULT_MEMORY_GUIDE) +
    (memText ? `\n\n# 已記住的事實（跨 session）\n${memText}` : '') +
    skills.promptSection();

  const getPlanMode = config.getPlanMode || (() => false);

  // 守衛鏈第 5 格：真實權限/沙箱（A 半部：靜態策略 deny/網路/提權/越界寫入 + 危險命令）。
  const permission = createPermissionStep({
    registry, getSandbox, getSandboxConfig,
    deny: pack.permissionPolicy?.deny || [],
    confirm: config.confirm,
  });

  const guard = composeGuards({
    planGuard: (ctx) => (getPlanMode() && mutatingTools.has(ctx.name)
      ? { block: true, reason: '計劃模式：只能規劃不能執行。請描述你打算怎麼做。' }
      : undefined),
    circuitBreaker: config.circuitBreaker || (() => undefined),
    packPreTool: pack.preToolPolicy,
    preToolHooks: config.preToolHooks || ((ctx) => runPreToolHooks(hooks, ctx.name, cwd)), // 第 4 格：PreToolUse
    permission,
    services,
  });

  const api = {
    pack,
    registry,
    mutatingTools,
    systemPrompt,
    services,
    permissionPolicy: pack.permissionPolicy || {},
    sandbox: { isOn: () => getSandbox(), config: () => getSandboxConfig() },
    memory,
    /** 撤銷上一次檔案改動（write/edit）：還原內容，新建的檔則刪除。 */
    undo: () => {
      const snap = undoStack.pop();
      if (!snap) return { undone: false, reason: '沒有可撤銷的改動' };
      try {
        if (snap.before === null) { if (existsSync(snap.path)) unlinkSync(snap.path); }
        else writeFileSync(snap.path, snap.before, 'utf8');
        return { undone: true, path: snap.rel, created: snap.before === null };
      } catch (e) { return { undone: false, reason: e.message }; }
    },
    // session 持久化 / resume（按 pack 分目錄）。CLI 用它存檔與續接。
    session: {
      dir: sessionsDir,
      newId: () => newSessionId(),
      save: (id, messages) => saveSession(sessionsDir, id, { messages, model: config.model }),
      load: (id) => loadSession(sessionsDir, id),
      list: () => listSessions(sessionsDir),
      latest: () => latestSession(sessionsDir),
    },
    /** 對一次工具呼叫跑守衛鏈，回傳決策（不執行）。 */
    guardToolCall: (toolCall) => guard(toolCall),
    /**
     * 跑守衛鏈，通過才執行工具。回 { blocked, reason } 或 { result }。
     * 這是 agent loop 中「一次工具呼叫」的確定性切片，可不靠 LLM 測試/示範。
     */
    runTool: async (name, args = {}, extra = {}) => {
      const ctx = { name, args, ...extra };
      const decision = await guard(ctx);
      if (decision?.block) return { blocked: true, reason: decision.reason };
      const tool = registry.get(name);
      const result = await tool.execute(`call-${name}`, args, extra.signal, extra.onUpdate, services);
      return { result };
    },
    /**
     * 跑一輪：把使用者輸入交給 LLM，驅動「串流 → 工具呼叫（過守衛鏈）→ 回灌 → 再串流」多步循環，
     * 直到模型不再呼叫工具。移植自 xitto-code 的 Agent loop；守衛鏈接到 Agent.beforeToolCall。
     * @param {string} input
     * @param {{ onEvent?: (e: object) => void, onAgent?: (agent: object) => void, history?: object[] }} [opts]
     *        onAgent：建立 Agent 後、prompt 前同步回呼（讓 CLI 拿到 agent 以便 Ctrl+C abort）。
     *        history：延續上一輪的 messages（多輪對話）。
     * @returns {Promise<{ text: string, messages: object[], agent: object, aborted: boolean }>}
     */
    runTurn: async (input, opts = {}) => {
      if (!config.model) throw new Error('runTurn 需要 config.model（LLM model 物件）。');
      if (!config.getApiKey) throw new Error('runTurn 需要 config.getApiKey。');
      const { Agent } = await import('./agent-loop.js');
      const streamFn = config.streamFn || (await import('./provider.js')).defaultStreamFn();
      const model = config.model;

      const agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          tools: registry.all(),
          messages: opts.history || [],   // 多輪對話：延續歷史
          thinkingLevel: config.thinkingLevel || (model.reasoning ? 'medium' : 'off'),
        },
        getApiKey: config.getApiKey,
        streamFn,
        // 守衛鏈接線：Agent 的 ctx 形狀 → kernel guard 的 { name, args }
        beforeToolCall: async (ctx) => guard({
          name: ctx.toolCall?.name,
          args: ctx.args,
          assistantMessage: ctx.assistantMessage,
        }),
        // 回合內壓縮：每次串流前若逼近視窗，就地摘要較舊對話、保留最近，繼續同回合
        maybeCompactInTurn: async () => {
          const s = resolveCompactionSettings(config.compaction, model.contextWindow);
          if (!s.enabled) return null;
          let apiKey; try { apiKey = await config.getApiKey(model.provider); } catch { return null; }
          const info = await maybeCompact(agent, model, apiKey, s);
          if (info && !info.error) opts.onEvent?.({ type: 'compact', ...info });
          return info;
        },
        toolExecution: 'sequential',
      });
      // 追蹤本輪改動 + PostToolUse hooks（成功工具後跑命令，失敗回灌讓 agent 修正）
      let turnModified = false;
      agent.subscribe((e) => {
        if (e.type !== 'tool_execution_end' || e.isError) return;
        if (mutatingTools.has(e.toolName)) turnModified = true;
        for (const f of runPostToolHooks(hooks, e.toolName, cwd)) {
          opts.onEvent?.({ type: 'hook_fail', command: f.command, output: f.output });
          agent.steer({ role: 'user', content: `[PostToolUse] \`${f.command}\` 失敗：\n${(f.output || '').slice(0, 2000)}\n請修正後再繼續。` });
        }
      });
      if (opts.onEvent) agent.subscribe((e) => opts.onEvent(e));
      opts.onAgent?.(agent); // 讓呼叫端拿到 agent（Ctrl+C → agent.abort()）

      await agent.prompt(input);
      const wasAborted = () => [...agent.state.messages].reverse().find((m) => m.role === 'assistant')?.stopReason === 'aborted';

      // 收尾自我驗收（pack.verify）：失敗則把輸出回灌讓 agent 修正，最多 maxRounds 輪。
      // 對標 xitto-code 的 runAutoVerify；機制在 kernel、「跑什麼/何時跑」由 pack 決定。
      if (pack.verify && !wasAborted()) {
        const maxRounds = Number.isInteger(pack.verify.maxRounds) ? pack.verify.maxRounds : 2;
        for (let round = 0; round < maxRounds; round++) {
          const vctx = { turnModified, cwd };
          const shouldRun = pack.verify.shouldRun ? pack.verify.shouldRun(vctx) : turnModified;
          if (!shouldRun) break;
          opts.onEvent?.({ type: 'verify_start' });
          let v;
          try { v = await pack.verify.run(vctx); } catch (e) { v = { ok: false, output: e?.message || String(e) }; }
          opts.onEvent?.({ type: 'verify_end', ok: !!v?.ok, output: v?.output });
          if (v?.ok) break;
          turnModified = false;
          await agent.prompt(`[自動驗收] 驗證失敗，輸出如下：\n${String(v?.output || '').slice(0, 4000)}\n請修正使其通過。`);
          if (wasAborted() || !turnModified) break; // 中斷或 agent 沒再改 → 停止避免空轉
        }
      }

      const messages = agent.state.messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      const text = (lastAssistant?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      const aborted = lastAssistant?.stopReason === 'aborted';
      return { text, messages, agent, aborted, turnModified };
    },

    /**
     * 目標驅動自主循環：反覆 runTurn + LLM 自我驗收，直到達成 / 到上限 / 連續無進展。
     * @param {string} goal
     * @param {{ maxRounds?: number, history?: object[], onRound?, onCheck?, onEvent?, onAgent?, signal? }} [opts]
     * @returns {Promise<{ done: boolean, rounds: number, history: object[], stalled?: boolean, aborted?: boolean }>}
     */
    runGoal: async (goal, opts = {}) => {
      if (!config.model) throw new Error('runGoal 需要 config.model。');
      const maxRounds = opts.maxRounds || 12;
      const NO_PROGRESS_CAP = 3;
      let history = opts.history || [];
      let instruction = `目標：${goal}\n\n請著手完成這個目標；可自由使用工具（讀寫檔/跑命令/抓網頁/子 agent…）。完成後簡述你做了什麼、如何驗證。`;
      let lastRemaining = null;
      let noProgress = 0;
      let verifyErrors = 0;
      for (let round = 1; round <= maxRounds; round++) {
        opts.onRound?.({ round, maxRounds });
        const r = await api.runTurn(instruction, { history, onEvent: opts.onEvent, onAgent: opts.onAgent });
        history = r.messages;
        if (r.aborted) return { done: false, aborted: true, rounds: round, history };
        let apiKey; try { apiKey = await config.getApiKey(config.model.provider); } catch { /* 略 */ }
        const judge = config.checkGoal || checkGoal; // 可注入自訂驗收（測試 / app 客製）
        const v = await judge(goal, history, config.model, apiKey, opts.signal);
        opts.onCheck?.({ round, done: v.done, remaining: v.remaining });
        if (v.done) return { done: true, rounds: round, history };
        noProgress = r.turnModified ? 0 : noProgress + 1;
        if (noProgress >= NO_PROGRESS_CAP) return { done: false, stalled: true, rounds: round, history };
        // 驗收壞掉（網路/解析）：remaining 是噪音，不拿來比對；連續壞 3 次就停（別空轉到上限）
        if (v.error) {
          verifyErrors += 1;
          if (verifyErrors >= 3) return { done: false, verifyBroken: true, rounds: round, history };
          instruction = `（驗收暫時無法判定）請繼續完成目標並自我檢查：${goal}`;
          continue;
        }
        verifyErrors = 0;
        const rem = normalizeFeedback(v.remaining);
        if (!r.turnModified && rem && rem === lastRemaining) return { done: false, stalled: true, rounds: round, history };
        lastRemaining = rem;
        instruction = `目標尚未達成。驗收回饋：${v.remaining}\n請繼續完成目標：${goal}`;
      }
      return { done: false, maxedOut: true, rounds: maxRounds, history };
    },
  };
  return api;
}
