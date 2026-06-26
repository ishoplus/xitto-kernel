// Kernel 組裝 — 把一個 DomainPack 接上領域無關的執行期。
// 確定性那半部：pack 載入、工具註冊、mutatingTools 推導、固定順序守衛鏈、systemPrompt 組裝、
// 單一工具呼叫（runTool）。LLM 那半部：runTurn 驅動移植自 xitto-code 的 Agent loop
// （串流 + 多步工具循環 + 守衛接線）。壓縮/TUI 仍為後續接縫。
import { loadPack } from './pack-loader.js';
import { createToolRegistry, deriveMutatingTools, isSandboxable } from './tool-registry.js';
import { composeGuards } from './guard-chain.js';
import { createPermissionStep } from './security/permission-step.js';
import { normalizeSandbox, wrapWithSeatbelt } from './security/sandbox.js';

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

  // 沙箱策略：config.sandbox > pack.permissionPolicy.sandbox > 預設（關）。
  const sandboxCfg = normalizeSandbox(config.sandbox ?? pack.permissionPolicy?.sandbox);
  const getSandbox = config.getSandbox || (() => !!sandboxCfg.enabled);
  const getSandboxConfig = () => sandboxCfg;

  // 工具：sandboxable 的在執行期包進 Seatbelt（OS 級隔離，B 半部）；其餘原樣。
  const tools = pack.tools().map((t) => wrapSandboxable(t, { cwd, getSandbox, getSandboxConfig }));
  const registry = createToolRegistry(tools);
  const mutatingTools = new Set(deriveMutatingTools(pack, tools));
  const services = {
    cwd,
    sandbox: { isOn: () => getSandbox(), config: () => getSandboxConfig() },
    ...(config.services || {}),
  };

  const systemPrompt =
    pack.systemPrompt +
    '\n\n# 記憶\n' + (pack.memoryGuide || DEFAULT_MEMORY_GUIDE);

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
      if (opts.onEvent) agent.subscribe((e) => opts.onEvent(e));
      opts.onAgent?.(agent); // 讓呼叫端拿到 agent（Ctrl+C → agent.abort()）

      await agent.prompt(input);

      const messages = agent.state.messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      const text = (lastAssistant?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      const aborted = lastAssistant?.stopReason === 'aborted';
      return { text, messages, agent, aborted };
    },
  };
}
