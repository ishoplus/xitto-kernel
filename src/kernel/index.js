// Kernel 組裝 — 把一個 DomainPack 接上領域無關的執行期。
// 確定性那半部：pack 載入、工具註冊、mutatingTools 推導、固定順序守衛鏈、systemPrompt 組裝、
// 單一工具呼叫（runTool）。LLM 那半部：runTurn 驅動移植自 xitto-code 的 Agent loop
// （串流 + 多步工具循環 + 守衛接線）。壓縮/TUI 仍為後續接縫。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadPack } from './pack-loader.js';
import { createToolRegistry, deriveMutatingTools, isSandboxable } from './tool-registry.js';
import { composeGuards } from './guard-chain.js';
import { createPermissionStep } from './security/permission-step.js';
import { normalizeSandbox, wrapWithSeatbelt } from './security/sandbox.js';
import { createMemory } from './memory.js';
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

  // 沙箱策略：config.sandbox > pack.permissionPolicy.sandbox > 預設（關）。
  const sandboxCfg = normalizeSandbox(config.sandbox ?? pack.permissionPolicy?.sandbox);
  const getSandbox = config.getSandbox || (() => !!sandboxCfg.enabled);
  const getSandboxConfig = () => sandboxCfg;

  // 工具：pack 工具（sandboxable 的包 Seatbelt）+ kernel 內建記憶工具（任何 pack 都有）。
  const tools = [
    ...pack.tools().map((t) => wrapSandboxable(t, { cwd, getSandbox, getSandboxConfig })),
    ...memory.tools,
  ];
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
    (memText ? `\n\n# 已記住的事實（跨 session）\n${memText}` : '');

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
    preToolHooks: config.preToolHooks || (() => undefined),
    permission,
    services,
  });

  return {
    pack,
    registry,
    mutatingTools,
    systemPrompt,
    services,
    permissionPolicy: pack.permissionPolicy || {},
    sandbox: { isOn: () => getSandbox(), config: () => getSandboxConfig() },
    memory,
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
        toolExecution: 'sequential',
      });
      // 追蹤本輪是否有成功的「會改動」工具（供 verify.shouldRun 判斷）
      let turnModified = false;
      agent.subscribe((e) => {
        if (e.type === 'tool_execution_end' && !e.isError && mutatingTools.has(e.toolName)) turnModified = true;
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
      return { text, messages, agent, aborted };
    },
  };
}
