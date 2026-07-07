// Kernel 組裝 — 把一個 DomainPack 接上領域無關的執行期。
// 確定性那半部：pack 載入、工具註冊、mutatingTools 推導、固定順序守衛鏈、systemPrompt 組裝、
// 單一工具呼叫（runTool）。LLM 那半部：runTurn 驅動移植自 xitto-code 的 Agent loop
// （串流 + 多步工具循環 + 守衛接線）。壓縮/TUI 仍為後續接縫。
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, relative } from 'node:path';
import { loadPack } from './pack-loader.js';
import { createToolRegistry, deriveMutatingTools, isSandboxable } from './tool-registry.js';
import { composeGuards } from './guard-chain.js';
import { createPermissionStep } from './security/permission-step.js';
import { fileAllowStore, memoryAllowStore } from './security/allow-store.js';
import { normalizeSandbox, wrapWithSeatbelt, sandboxViolation } from './security/sandbox.js';
import { dangerousReason } from './security/danger.js';
import { lineDiff } from './diff.js';
import { spawnSync } from 'node:child_process';
import { createMemory } from './memory.js';
import { createPlaybook } from './playbook.js';
import { createEpisodes } from './episodes.js';
import { extractFacts } from './extract.js';
import { createTodo } from './todo.js';
import { createSpawnTool, createMapTool } from './subagent.js';
import { createAgents } from './agents.js';
import { createSkills } from './skills.js';
import { loadHooks, runPreToolHooks, runPostToolHooks } from './hooks.js';
import { maybeCompact, resolveCompactionSettings } from './compaction.js';
import { checkGoal, normalizeFeedback } from './goal-loop.js';
import { newSessionId, saveSession, loadSession, listSessions, latestSession } from './session.js';
import { defaultStreamFn } from './provider.js';
import { createModelLogger, withLogging, resolveRetry, attachLoopLogger } from './log.js';

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

// 交付物偵測：掃工作目錄前後快照,diff 出「產出/改動的檔案」（pack 無關,連 bash 寫的也抓得到）。
const SKIP_SCAN = new Set(['.xitto-kernel', 'node_modules', '.git', '.swebench-repos', '.xitto-server', 'tmp']);
function scanWorkdir(dir, base = dir, acc = new Map(), depth = 0) {
  if (depth > 8 || acc.size > 5000) return acc;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SKIP_SCAN.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) scanWorkdir(full, base, acc, depth + 1);
    else if (e.isFile()) { try { const s = statSync(full); acc.set(relative(base, full), `${s.mtimeMs}:${s.size}`); } catch { /* 略 */ } }
  }
  return acc;
}
function diffWorkdir(before, after) {
  const created = [], modified = [];
  for (const [rel, sig] of after) { if (!before.has(rel)) created.push(rel); else if (before.get(rel) !== sig) modified.push(rel); }
  return { created: created.sort(), modified: modified.sort() };
}

const DEFAULT_MEMORY_GUIDE =
  '遇到值得跨 session 記住的事實（使用者偏好、踩過的坑、專案決策）時，當下就存一條。';

const DEFAULT_PLAYBOOK_GUIDE =
  '摸清這個專案的「做事方法」(如何建置/測試/執行/部署、慣例、必經步驟、坑與修法)時，用 playbook_update 按 topic 記下來(同 topic 覆蓋)；過時就用 playbook_remove 清掉。下次自動載入，不必重新摸索。分工：memory 存事實/偏好/決策，playbook 存可重複的程序步驟。';

const DEFAULT_EPISODE_GUIDE =
  '完成有價值的任務後，用 episode_record 記一筆情節(做了什麼+結果+tags)；遇到相似任務時系統會自動召回最相關的幾筆供參考，也可主動用 episode_recall 查。';

const DEFAULT_OUTPUT_GUIDE =
  '產出檔案時：最終成品放工作目錄根、用清楚好懂的檔名(如 report.md、budget.csv，別用 tmp_3.txt)；中間/暫存檔(下載、草稿、解壓內容、爬到的原始資料)一律放 tmp/ 目錄——那是過程檔，不算成品也可能被清掉。';

// 語系驅動的語言提示：依使用者輸入偵測語系，注入「該語言」的具體指令（具體「全程用 X」> 通用「跟隨使用者」，
// 能壓過中文 prompt 的體量）。這些指令使用者永遠看不到；輸出語言跟著使用者走 → 中文需求全程中文、English all in English。
function detectLang(text = '') {
  const s = String(text);
  if (/[぀-ヿ]/.test(s)) return 'ja';                  // 日文假名
  if (/[가-힯]/.test(s)) return 'ko';                  // 韓文諺文
  if (/[㐀-䶿一-鿿]/.test(s)) return 'zh';     // 漢字 → 視為中文
  return 'en';
}
const LANG_DIRECTIVE = {
  zh: '【語言】全程使用繁體中文：你的回覆、思考、進度與驗收敘述、摘要、成品檔案內容一律用繁體中文（除非使用者明確要求其他語言）。',
  en: '[Language] Respond ONLY in English for everything: your replies, reasoning, progress/verification narration, summaries, and deliverable file contents (unless the user explicitly asks for another language).',
  ja: '[言語] 返信・思考・進捗・検証の説明・要約・成果物の内容はすべて日本語で出力してください（ユーザーが他の言語を明示しない限り）。',
  ko: '[언어] 답변·사고·진행/검증 설명·요약·결과물 내용을 모두 한국어로 작성하세요(사용자가 다른 언어를 명시하지 않는 한).',
};
const langDirectiveFor = (lang) => (LANG_DIRECTIVE[lang] || `[Language] Respond only in "${lang}" for all output unless the user asks otherwise.`) + '\n\n';

// goal loop 指令外殼：依語系給模板，別對英文目標餵中文鷹架（鷹架語言也會帶偏輸出）。zh/en 為主，其餘退 en。
const GOAL_TEMPLATES = {
  zh: {
    start: (g) => `目標：${g}\n\n請著手完成這個目標；可自由使用工具（讀寫檔/跑命令/抓網頁/子 agent…）。完成後簡述你做了什麼、如何驗證。`,
    retry: (g, rem) => `目標尚未達成。驗收回饋：${rem}\n請繼續完成目標：${g}`,
    broken: (g) => `（驗收暫時無法判定）請繼續完成目標並自我檢查：${g}`,
    steerHead: '\n\n[使用者中途補充，請納入考量並據此調整]\n',
  },
  en: {
    start: (g) => `Goal: ${g}\n\nGet this goal done; use any tools you need (read/write files, run commands, fetch the web, sub-agents…). When finished, briefly state what you did and how you verified it.`,
    retry: (g, rem) => `The goal is not done yet. Reviewer feedback: ${rem}\nKeep working to complete the goal: ${g}`,
    broken: (g) => `(Verification temporarily unavailable.) Keep completing the goal and self-check: ${g}`,
    steerHead: '\n\n[Mid-task additions from the user — take them into account and adjust]\n',
  },
};
const goalTemplatesFor = (lang) => GOAL_TEMPLATES[lang] || GOAL_TEMPLATES.en;

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
const isTextContent = (s) => s == null || !String(s).includes("\u0000");
function wrapUndo(tool, { cwd, undoStack }) {
  if (tool.mutating !== true || typeof tool.execute !== 'function') return tool;
  const orig = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (id, params, ...rest) => {
      let abs = null, before = null;
      if (params?.path) {
        abs = isAbsolute(params.path) ? params.path : join(cwd, params.path);
        try {
          before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
          undoStack.push({ path: abs, rel: params.path, before });
          if (undoStack.length > 50) undoStack.shift();
        } catch { /* 略 */ }
      }
      const result = await orig(id, params, ...rest);
      // 集中算 diff：用 before 快照 + 改後內容，掛在 result._diff（不進 LLM content，僅供 app 渲染）
      if (abs && result && typeof result === 'object' && isTextContent(before)) {
        try {
          const after = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
          if (isTextContent(after)) { const d = lineDiff(before, after); if (d) result._diff = { path: params.path, ...d }; }
        } catch { /* 略 */ }
      }
      return result;
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
/**
 * 一輪對話結束後的「保底提示」：把非正常結局翻成一句人話，讓使用者永遠知道發生什麼，
 * 而不是對著半截文字或空白泡泡發呆。回傳空字串＝正常有內容、無須提示。
 * @param {string} stopReason  runTurn 回傳的 stopReason（'stop'|'length'|'toolUse'|'error'|'aborted'）
 * @param {boolean} hasText    這輪是否有任何文字內容
 * @returns {string}
 */
export function turnNotice(stopReason, hasText) {
  if (stopReason === 'length') return '⚠ 回覆已達輸出上限被截斷（可調高 model 的 maxTokens）';
  if (stopReason === 'error') return '⚠ 產生回覆時發生錯誤，請重試';
  if (stopReason === 'aborted') return '（已中斷）';
  if (!hasText) return '（模型這輪沒有產生任何內容，請重試）';
  return '';
}

export function createKernel(pack, config = {}) {
  loadPack(pack);
  const cwd = config.cwd || process.cwd();

  // 每個 pack 在 cwd 下有獨立資料夾（記憶、session 分領域存放，互不混）
  const dataDir = join(cwd, '.xitto-kernel', pack.name);
  const memory = createMemory(join(dataDir, 'memory.md'));
  const playbook = createPlaybook(join(dataDir, 'playbook.md'));
  const episodes = createEpisodes(join(dataDir, 'episodes.jsonl'));

  // 模型介面日誌 + 自動重試：包住 provider streamFn，記錄每次 LLM 呼叫（請求 body / HTTP 狀態 / 串流時序 /
  // stopReason / usage / 錯誤原文），並把結果分類成 outcome（empty=「沒回覆就中斷」的核心徵狀）；連線錯 /
  // 429 / 5xx 由 SDK 層自動重試。可用 XITTO_LOG*（日誌）與 XITTO_LLM_*（重試/逾時）環境變數調整或關閉。
  const modelLogger = createModelLogger(config.logging === false ? { enabled: false } : { ...(config.logging || {}), dataDir });
  const retryCfg = resolveRetry(config.retry);
  const baseStreamFn = config.streamFn || defaultStreamFn();
  const mkStreamFn = (label, turnId) => withLogging(baseStreamFn, modelLogger, { ...retryCfg, label, turnId });
  let turnSeq = 0;
  const newTurnId = () => `t${(++turnSeq).toString(36)}-${Date.now().toString(36).slice(-5)}`;

  // 事實層自動萃取：從對話抽持久事實存進 memory（去重靠 memory.save + existing 過濾）。
  let lastMessages = [];
  const doExtract = async (messages) => {
    if (!config.model || !config.getApiKey) return { extracted: [] };
    const streamFn = mkStreamFn('extract');
    const facts = await extractFacts({ model: config.model, getApiKey: config.getApiKey, streamFn, messages: messages || [], existing: memory.list() });
    const saved = [];
    for (const f of facts) { if (memory.save(f).saved) saved.push(f); }
    return { extracted: saved };
  };
  const todo = createTodo();
  const sessionsDir = join(dataDir, 'sessions');
  const hooks = loadHooks(join(dataDir, 'settings.json')); // PreToolUse/PostToolUse

  // 沙箱策略：config.sandbox > pack.permissionPolicy.sandbox > 預設（關）。
  const sandboxCfg = normalizeSandbox(config.sandbox ?? pack.permissionPolicy?.sandbox);
  const getSandbox = config.getSandbox || (() => !!sandboxCfg.enabled);
  const getSandboxConfig = () => sandboxCfg;

  // ── 環境能力門控 ──
  // 讓「工具/技能」與「運行環境」對齊：雲端託管容器 vs 使用者本機，可用的能力不同。
  // 不滿足的能力對應的工具/技能「一開始就不註冊、不列出」→ 模型根本看不到，從源頭避免在錯的環境誤用無效工具/技能。
  //   config.caps：本環境具備的能力字串（如 ['workspaceFs','hostFs','shell','network']）。未提供 → 不門控（本機 CLI 全能力，向後相容）。
  //   config.env ：環境名（'cloud'|'local'…），供以 env: 標記的工具/技能精準匹配。
  //   宣告方式：工具用 requires:[cap,…]（或 env:'local'）；技能用 frontmatter `requires: a,b` / `env: local`。
  const caps = config.caps ? new Set(config.caps) : null;
  const envName = config.env || null;
  const envAllows = (meta) => {
    if (!meta) return true;
    const req = Array.isArray(meta.requires) ? meta.requires
      : (typeof meta.requires === 'string' ? meta.requires.split(/[,\s]+/).filter(Boolean) : null);
    if (caps && req && req.length && !req.every((c) => caps.has(c))) return false; // 缺所需能力
    if (envName && meta.env && meta.env !== 'any' && meta.env !== envName) return false; // 環境不符
    return true;
  };

  // 技能驗證器：結晶新技能前，先在沙箱跑一條驗證指令，須 exit 0 才准新增（結晶=已驗證的成功）。
  // 靜態安全：危險指令一律擋；開沙箱時併查靜態策略，再用 Seatbelt 包執行。
  const runVerify = (command, { timeoutMs = 60000 } = {}) => {
    const cmd = String(command || '').trim();
    if (!cmd) return { ok: false, blocked: true, reason: 'verify 指令為空' };
    const danger = dangerousReason(cmd);
    if (danger) return { ok: false, blocked: true, reason: `驗證指令危險（${danger}），拒絕執行` };
    if (getSandbox()) {
      const v = sandboxViolation(cmd, getSandboxConfig());
      if (v) return { ok: false, blocked: true, reason: `驗證指令違反沙箱策略（${v}）` };
    }
    const finalCmd = (getSandbox() ? wrapWithSeatbelt(cmd, { cwd, cfg: getSandboxConfig() }) : null) || cmd;
    const r = spawnSync(finalCmd, { shell: true, cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    const output = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 4000);
    if (r.error) return { ok: false, code: null, output: (output + ' ' + r.error.message).trim() };
    return { ok: r.status === 0, code: r.status, output: output || '(no output)' };
  };
  const skills = createSkills(join(dataDir, 'skills'), { verifyRunner: runVerify, capFilter: envAllows }); // 漸進揭露 + 結晶（須驗證）；capFilter：環境不支援的技能不列不載
  const agents = createAgents(join(dataDir, 'agents')); // 自訂 agent 類型（spawn_agent/spawn_agents 的 agentType）

  // 澄清通道：app 提供 askUser 才有 ask_user 工具（結果導向:自主完成,只在非問不可時才打斷使用者）。
  const askUserTool = typeof config.askUser === 'function' ? {
    name: 'ask_user', label: '詢問使用者', readOnly: true,
    description: '只在「缺少關鍵資訊、無法合理推斷、或決策會明顯改變結果」時,才向使用者提問並等待回答。能自己判斷、能用合理預設就別問——盡量自主完成,把打斷降到最低。回傳使用者的回答。',
    parameters: { type: 'object', properties: { question: { type: 'string', description: '簡短、具體的問題' }, options: { type: 'array', items: { type: 'string' }, description: '可選:提供幾個選項供使用者挑' } }, required: ['question'] },
    execute: async (_id, { question, options }) => {
      let answer; try { answer = await config.askUser({ question, options }); } catch { answer = null; }
      const text = (answer == null || answer === '') ? '(使用者未回答；請用合理預設繼續，不要再追問)' : String(answer);
      // 同時回傳 question + 明確指示，讓模型把回答當權威依據（即使對話很長也不會脫鉤）
      return { content: [{ type: 'text', text: JSON.stringify({ question: String(question || ''), answer: text, note: '這是使用者對你提問的回答，請以此為準繼續，不要忽略或再問同一件事。' }) }] };
    },
  } : null;

  // 工具：pack 工具（sandboxable 包 Seatbelt、mutating+path 加 undo 快照）+ kernel 內建記憶工具 + spawn_agent。
  // 先做環境門控：requires/env 不滿足的 pack 工具直接剔除（不進 registry → 不出現在給模型的工具清單）。
  const undoStack = [];
  const envDroppedTools = [];
  const packToolsForEnv = pack.tools().filter((t) => envAllows(t) || (envDroppedTools.push(t.name), false));
  const baseTools = [
    ...packToolsForEnv.map((t) => wrapUndo(wrapSandboxable(t, { cwd, getSandbox, getSandboxConfig }), { cwd, undoStack })),
    ...memory.tools,
    ...playbook.tools,
    ...episodes.tools,
    ...(askUserTool ? [askUserTool] : []),
    todo.tool,
    ...skills.tools,
    ...(config.extraTools || []),  // 外部注入（MCP 工具等）：由 app 層先 async 載入再傳入
  ];
  // spawn_agent / spawn_agents：派唯讀子 agent（單一 / 平行 map）。
  // 子 agent 可用工具 = 所有唯讀工具，但**排除 spawn 自己**（避免遞迴 / 平行爆量）。
  let allTools = baseTools;
  const subDeps = {
    getModel: () => config.model,
    getApiKey: config.getApiKey,
    getStreamFn: () => mkStreamFn('subagent'), // 與 kernel 同一個 provider（含日誌+重試包裝）；測試注入的 fake 也一併被包
    getReadOnlyTools: () => allTools.filter((t) => t.readOnly === true && t.name !== 'spawn_agent' && t.name !== 'spawn_agents'),
    getAgentType: (name) => agents.get(name), // 自訂 agent 類型：以其專屬 prompt + 工具子集跑子 agent
  };
  const spawnTool = createSpawnTool(subDeps);
  const mapTool = createMapTool(subDeps);
  // delegate：把聚焦子任務委派給某 agent 類型「可寫」執行——路由到 runTurn（重用守衛/沙箱/undo/verify），
  // 用該類型的 prompt + 工具白名單（含可寫）+ 可選 per-agent model。對標 CC subagents 的可寫委派。
  const dTxt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });
  const delegateTool = {
    name: 'delegate', label: '委派子 agent',
    description: '把一個聚焦子任務委派給某個 agent 類型「可寫」執行（能改檔/跑命令，全程經守衛/沙箱）。'
      + '用 agentType 指定類型（見系統提示「可用的 agent 類型」），回傳子 agent 結論。把獨立子任務交給專長子 agent，主對話保持乾淨。只需唯讀調查請改用 spawn_agent。',
    parameters: { type: 'object', properties: {
      agentType: { type: 'string', description: 'agent 類型名（見「可用的 agent 類型」）' },
      task: { type: 'string', description: '要委派的具體子任務（自足、可獨立完成）' },
    }, required: ['agentType', 'task'] },
    execute: async (_id, { agentType, task }, _signal, onPartial) => {
      const type = agents.get(agentType);
      if (!type) return dTxt({ error: '找不到 agent 類型', agentType, available: agents.list().map((a) => a.name) });
      const model = (type.model && typeof config.resolveModel === 'function') ? (config.resolveModel(type.model) || config.model) : config.model;
      try {
        const r = await api.runTurn(String(task || ''), {
          systemPromptOverride: type.systemPrompt,
          toolNames: type.tools && type.tools.length ? type.tools : undefined,
          model,
          skipVerify: true, // 子委派不跑 pack.verify（驗證留給主 agent / orchestrator）
          // 把委派子 agent 的工具活動即時轉發為 sub_tool（UI 嵌套在 delegate 步驟下，與 spawn_agent 一致）
          onEvent: typeof onPartial === 'function' ? (ev) => {
            if (ev.type === 'tool_execution_start') onPartial({ kind: 'subagent', phase: 'start', name: ev.toolName, args: ev.args });
            else if (ev.type === 'tool_execution_end') onPartial({ kind: 'subagent', phase: 'end', name: ev.toolName, isError: !!ev.isError });
          } : undefined,
        });
        return dTxt({ delegatedTo: type.name, aborted: !!r.aborted, text: r.text });
      } catch (e) { return dTxt({ error: e?.message || String(e), agentType }); }
    },
  };
  const tools = [...baseTools, spawnTool, mapTool, delegateTool];
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
  const pbText = playbook.load();
  const systemPrompt =
    pack.systemPrompt +
    loadContextFiles(cwd, pack.contextFiles) +          // 注入領域規範檔（CLAUDE.md 等）
    '\n\n# 記憶與專案手冊\n' + (pack.memoryGuide || DEFAULT_MEMORY_GUIDE) + '\n' + DEFAULT_PLAYBOOK_GUIDE + '\n' + DEFAULT_EPISODE_GUIDE +
    '\n\n# 工作目錄\n你的工作目錄是：' + cwd + '\n所有檔案請用相對路徑寫在這個目錄內（如 report.md、data/x.csv）。除非使用者明確要求，絕對不要寫到此目錄之外（例如 /tmp、/app、/workspace、系統根目錄）——寫在外面使用者拿不到成品。' +
    (config.envNote ? '\n\n# 運行環境\n' + config.envNote : '') +   // app 注入的環境邊界（雲端/本機能力差異），讓模型不去試無效工具
    '\n\n# 成品與暫存\n' + DEFAULT_OUTPUT_GUIDE +
    (memText ? `\n\n# 已記住的事實（跨 session）\n${memText}` : '') +
    (pbText ? `\n\n# 專案手冊（這個專案怎麼做事，跨 session 累積）\n${pbText}` : '') +
    (askUserTool ? '\n\n# 詢問\n盡量自主完成目標。只在缺少關鍵資訊、無法合理推斷、或決策會明顯改變結果時，才用 ask_user 問使用者；能用合理預設就別問。' : '') +
    skills.promptSection() +
    agents.promptSection();

  const getPlanMode = config.getPlanMode || (() => false);

  // 漸進式放權：已信任的工具/命令簽章跨 session 累積。
  // 預設落地到 .xitto-kernel/<pack>/allow.json；config.allowStore=false → 不持久化（記憶體版）；給字串 → 自訂路徑。
  const allowStore = config.allowStore === false ? memoryAllowStore()
    : fileAllowStore(typeof config.allowStore === 'string' ? config.allowStore : join(dataDir, 'allow.json'));

  // 守衛鏈第 5 格：真實權限/沙箱（A 半部：靜態策略 deny/網路/提權/越界寫入 + 危險命令）。
  const permission = createPermissionStep({
    registry, getSandbox, getSandboxConfig,
    deny: pack.permissionPolicy?.deny || [],
    confirm: config.confirm,
    store: allowStore,
    onTrusted: config.onTrusted,
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
    // 已信任清單（漸進放權）：列出 / 移除 / 全清；path 為落地檔（記憶體版為 null）。
    permissions: {
      list: () => allowStore.list(),
      forget: (entry) => allowStore.remove(entry),
      clear: () => allowStore.clear(),
      path: allowStore.path,
    },
    sandbox: { isOn: () => getSandbox(), config: () => getSandboxConfig() },
    // 環境能力畫像 + 因環境被剔除的 pack 工具（供 app 記錄/診斷「為何某工具不見了」）。
    env: { name: envName, caps: caps ? [...caps] : null, droppedTools: envDroppedTools },
    memory,
    // 事實層自動萃取：從指定（或上一輪）對話抽持久事實存進 memory，回 { extracted: [...] }。
    extractMemory: (opts = {}) => doExtract(opts.messages || lastMessages),
    // 專案手冊（程序層沉澱）：列出 / 更新 / 移除 / 全清；path 為落地檔。
    playbook: { list: playbook.list, update: playbook.update, remove: playbook.remove, clear: playbook.clear, load: playbook.load, path: join(dataDir, 'playbook.md') },
    // 技能（結晶層 + 自我維護）：列出 / 移除 / 重掃 / 漂移複查；path 為技能資料夾。
    skills: { list: skills.list, remove: skills.remove, reload: skills.reload, check: skills.check, path: join(dataDir, 'skills') },
    agents: { list: agents.list, get: agents.get, reload: agents.reload, count: agents.count, path: join(dataDir, 'agents') },
    // 情節（情節層 + 相關性召回）：記錄 / 召回 / 列出 / 清空；path 為落地檔。
    episodes: { record: episodes.record, recall: episodes.recall, list: episodes.list, clear: episodes.clear, count: episodes.count, path: join(dataDir, 'episodes.jsonl') },
    todo: { get: todo.get },
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
      const turnId = newTurnId();                    // 關聯本輪的 model-calls 與 agent-loop 日誌
      const streamFn = mkStreamFn(opts.systemPromptOverride ? 'delegate' : 'main', turnId);
      const model = opts.model || config.model; // 可寫委派可指定 per-agent model

      // 語系驅動：偵測語言→注入該語言的具體指令在最前面（opts.lang > config.lang > 自動偵測）。
      const lang = opts.lang || config.lang || detectLang(input);
      // 自動相關性召回：把與本輪 input 最相關的過往情節注入 prompt（只 top-K,不全量倒）
      // systemPromptOverride：委派子 agent 用其類型的 prompt 取代 pack 主 prompt（仍保留語系與召回）。
      const turnSystemPrompt = langDirectiveFor(lang) + (opts.systemPromptOverride || systemPrompt) + (config.recallEpisodes === false ? '' : episodes.recallSection(input));
      // toolNames：工具白名單（委派子 agent 只拿類型允許的工具；含可寫，仍經守衛）。
      const baseTurnTools = opts.toolNames?.length ? registry.all().filter((t) => opts.toolNames.includes(t.name)) : registry.all();
      // 委派情境（systemPromptOverride）剝除 delegate/spawn——子 agent 不能再委派/派生（防遞迴，單層深度）。
      const turnTools = opts.systemPromptOverride
        ? baseTurnTools.filter((t) => !['delegate', 'spawn_agent', 'spawn_agents'].includes(t.name))
        : baseTurnTools;

      const agent = new Agent({
        initialState: {
          systemPrompt: turnSystemPrompt,
          model,
          tools: turnTools,
          messages: opts.history || [],   // 多輪對話：延續歷史
          // 思考強度：本輪 opts > kernel config > model.reasoning 預設。'off' 可強制關閉推理型 model 的思考。
          // 註：pi-ai 只在 model.reasoning=true 時才把思考參數送出線上，故對非推理 model 設 level 無效。
          thinkingLevel: opts.thinkingLevel || config.thinkingLevel || (model.reasoning ? 'medium' : 'off'),
        },
        getApiKey: config.getApiKey,
        streamFn,
        thinkingBudgets: config.thinkingBudgets || model.thinkingBudgets, // 每級思考 token 預算（anthropic 端點如 MiniMax 才生效；可在 config 或 providers.json 的 model 設定）
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
      attachLoopLogger(agent, modelLogger, { turnId }); // 記 agent-loop 過程（工具/回合/收尾），與 model-calls 同 turnId
      opts.onAgent?.(agent); // 讓呼叫端拿到 agent（Ctrl+C → agent.abort()）

      await agent.prompt(input);
      const wasAborted = () => [...agent.state.messages].reverse().find((m) => m.role === 'assistant')?.stopReason === 'aborted';

      // 收尾自我驗收（pack.verify）：失敗則把輸出回灌讓 agent 修正，最多 maxRounds 輪。
      // 對標 xitto-code 的 runAutoVerify；機制在 kernel、「跑什麼/何時跑」由 pack 決定。
      // 「完成定義」契約：把最終裁決＋證據掛到 result.verify，讓呼叫端能誠實呈現
      // 「✓ 通過 / ⚠ 未通過」而非把未驗收的成品當 done（信任＝可被自主採用的前提）。
      let verifyResult = null; // null = 不適用（pack 無 verify / 已中斷 / 本回合沒改動 / 委派時跳過）
      if (pack.verify && !wasAborted() && !opts.skipVerify) {
        const maxRounds = Number.isInteger(pack.verify.maxRounds) ? pack.verify.maxRounds : 2;
        let attempts = 0, last = null;
        for (let round = 0; round < maxRounds; round++) {
          const vctx = { turnModified, cwd };
          const shouldRun = pack.verify.shouldRun ? pack.verify.shouldRun(vctx) : turnModified;
          if (!shouldRun) break;
          opts.onEvent?.({ type: 'verify_start' });
          let v;
          try { v = await pack.verify.run(vctx); } catch (e) { v = { ok: false, output: e?.message || String(e) }; }
          opts.onEvent?.({ type: 'verify_end', ok: !!v?.ok, output: v?.output });
          attempts++; last = v;
          if (v?.ok) break;
          turnModified = false;
          await agent.prompt(`[自動驗收] 驗證失敗，輸出如下：\n${String(v?.output || '').slice(0, 4000)}\n請修正使其通過。`);
          if (wasAborted() || !turnModified) break; // 中斷或 agent 沒再改 → 停止避免空轉
        }
        if (last) verifyResult = { ran: true, ok: !!last.ok, output: String(last.output || '').slice(0, 4000), rounds: attempts };
      }

      const messages = agent.state.messages;
      lastMessages = messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      const text = (lastAssistant?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      const stopReason = lastAssistant?.stopReason || 'stop'; // 'stop'|'length'|'toolUse'|'error'|'aborted'
      const aborted = stopReason === 'aborted';
      const result = { text, stopReason, messages, agent, aborted, turnModified, verify: verifyResult };
      // 事實層自動萃取：非阻塞,把 promise 掛在 result 上供需要者 await（測試/headless）。
      if (config.autoExtractMemory && !aborted) {
        result.memoryExtraction = doExtract(messages)
          .then((r) => { if (r.extracted.length) opts.onEvent?.({ type: 'memory_extracted', facts: r.extracted }); return r; })
          .catch(() => ({ extracted: [] }));
      }
      return result;
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
      // 語系從「原始目標」鎖定整個 outcome（別讓中途中文回饋把英文任務帶偏）。opts.lang > config.lang > 偵測。
      const lang = opts.lang || config.lang || detectLang(goal);
      const T = goalTemplatesFor(lang);
      let history = opts.history || [];
      let instruction = T.start(goal);
      let lastRemaining = null;
      let noProgress = 0;
      let verifyErrors = 0;
      let sameFeedback = 0;
      let lastVerify = null; // 最後一次 pack.verify 裁決（DoD 證據，隨 outcome 回傳）
      for (let round = 1; round <= maxRounds; round++) {
        opts.onRound?.({ round, maxRounds });
        // 使用者中途補充（steering）：把上一輪之間累積的補充折進這一輪指令（回合內的即時補充走 agent.steer）。
        if (opts.drainSteer) {
          const extra = opts.drainSteer();
          if (extra && extra.length) instruction += T.steerHead + extra.map((s) => `- ${s}`).join('\n');
        }
        const r = await api.runTurn(instruction, { history, onEvent: opts.onEvent, onAgent: opts.onAgent, lang });
        history = r.messages;
        lastVerify = r.verify ?? lastVerify;
        if (r.aborted) return { done: false, aborted: true, rounds: round, history, verify: lastVerify };
        let apiKey; try { apiKey = await config.getApiKey(config.model.provider); } catch { /* 略 */ }
        const judge = config.checkGoal || checkGoal; // 可注入自訂驗收（測試 / app 客製）
        const v = await judge(goal, history, config.model, apiKey, opts.signal);
        opts.onCheck?.({ round, done: v.done, remaining: v.remaining });
        if (v.done) return { done: true, rounds: round, history, verify: lastVerify };
        noProgress = r.turnModified ? 0 : noProgress + 1;
        if (noProgress >= NO_PROGRESS_CAP) return { done: false, stalled: true, rounds: round, history, verify: lastVerify };
        // 驗收壞掉（網路/解析）：remaining 是噪音，不拿來比對；連續壞 3 次就停（別空轉到上限）
        if (v.error) {
          verifyErrors += 1;
          if (verifyErrors >= 3) return { done: false, verifyBroken: true, rounds: round, history, verify: lastVerify };
          instruction = T.broken(goal);
          continue;
        }
        verifyErrors = 0;
        const rem = normalizeFeedback(v.remaining);
        // 驗收回饋重複 = agent 在繞圈（即使一直有動作也沒朝驗收要求收斂,如查不到的資訊一直換來源）→ 連 2 次相同就停,別空轉到上限
        if (rem && rem === lastRemaining) { if (++sameFeedback >= 2) return { done: false, stalled: true, rounds: round, history, verify: lastVerify }; }
        else sameFeedback = 0;
        lastRemaining = rem;
        instruction = T.retry(goal, v.remaining);
      }
      return { done: false, maxedOut: true, rounds: maxRounds, history, verify: lastVerify };
    },

    /**
     * 結果導向：給目標 → 跑 goal loop → 回「交付物」（做了什麼 + 產出/改動的檔案 + 是否達成）。
     * 對非技術使用者:對話只是過程,這回傳的才是產品。
     * @param {string} goal
     * @param {object} [opts] 同 runGoal
     * @returns {Promise<{ goal, done, rounds, aborted, stalled, summary, artifacts: {created:string[], modified:string[]}, history }>}
     */
    runOutcome: async (goal, opts = {}) => {
      const before = scanWorkdir(cwd);
      const g = await api.runGoal(goal, opts);
      const artifacts = diffWorkdir(before, scanWorkdir(cwd));
      const lastAssistant = [...(g.history || [])].reverse().find((m) => m.role === 'assistant');
      const summary = (lastAssistant?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      // ③ 私有脈絡複利：完成 outcome 後自動記一筆情節（goal+結果+產出），
      // 下次相似任務由 recallSection 自動召回 → act→record→recall 閉環自動成立，無需 agent 主動記。
      // 去重靠 episodes.record（Jaccard>0.85 跳過）；中斷不記。可用 config.autoRecordEpisode=false 關閉。
      if (config.autoRecordEpisode !== false && !g.aborted) {
        try {
          const nFiles = (artifacts.created?.length || 0) + (artifacts.modified?.length || 0);
          const outcome = g.done ? 'success' : (g.stalled ? 'stalled' : 'incomplete');
          const epSummary = String(goal).replace(/\s+/g, ' ').trim().slice(0, 160) + (nFiles ? `（產出/改動 ${nFiles} 檔）` : '');
          const rec = episodes.record({ summary: epSummary, tags: [pack?.name].filter(Boolean), outcome });
          if (rec.recorded) opts.onEvent?.({ type: 'episode_recorded', id: rec.recorded, outcome });
        } catch { /* 記情節失敗不影響交付 */ }
      }
      return { goal, done: !!g.done, rounds: g.rounds, aborted: !!g.aborted, stalled: !!g.stalled, summary, artifacts, verify: g.verify || null, history: g.history };
    },

    /**
     * 可寫 map-verify（序列 + 快照回滾）：對每個項目跑一個可寫回合 → 逐項驗收
     * → 通過保留／未通過 undo 回滾該項所有檔案改動（保持工作區乾淨）。
     * 安全的「批次驗證型變更」：序列避開平行寫衝突，失敗自動復原。
     * 驗收來源優先序：item.verify（shell 指令）> pack.verify（result.verify）> 無（不擋但標記未驗）。
     * 限制：僅回滾「帶 path 的檔案改動」(undo 快照範圍)；bash 等非檔案副作用不在回滾內。
     * @param {Array<string|{task:string, verify?:string}>} items
     * @param {{ onEvent?, onAgent?, onItem? }} [opts]
     * @returns {Promise<{ total, passed, failed, results: Array<{task,ok,verified,rolledBack,verify,text}> }>}
     */
    mapVerify: async (items, opts = {}) => {
      if (!config.model) throw new Error('mapVerify 需要 config.model。');
      const norm = (Array.isArray(items) ? items : [])
        .map((it) => (typeof it === 'string' ? { task: it } : it))
        .filter((it) => it && String(it.task || '').trim());
      const results = [];
      for (const it of norm) {
        const mark = undoStack.length;                                   // 回滾點
        const r = await api.runTurn(String(it.task), { history: [], onEvent: opts.onEvent, onAgent: opts.onAgent });
        let verify;
        if (it.verify) {
          const vr = runVerify(String(it.verify));
          verify = { ran: true, ok: !!vr.ok && !vr.blocked, output: String(vr.output || vr.reason || '').slice(0, 2000), source: 'item' };
        } else if (r.verify) {
          verify = { ...r.verify, source: 'pack' };
        } else {
          verify = { ran: false, ok: true, source: 'none' };             // 無 verify → 不擋（標記未驗）
        }
        let rolledBack = false;
        if (verify.ran && !verify.ok) {
          while (undoStack.length > mark) api.undo();                    // 回滾此項所有檔案改動（LIFO）
          rolledBack = true;
        }
        const res = { task: it.task, ok: !!verify.ok, verified: verify.ran, rolledBack, verify, text: r.text };
        results.push(res);
        opts.onItem?.(res);
      }
      const passed = results.filter((x) => x.ok).length;
      return { total: results.length, passed, failed: results.length - passed, results };
    },
  };
  return api;
}
