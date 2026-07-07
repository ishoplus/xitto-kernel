// 自寫 agent loop — 取代 @mariozechner/pi-agent-core 的 Agent，保留 pi-ai 串流(streamFn)。
// 依 docs/agent-loop-spec.md 對齊契約。關鍵差異：直接在 live this._state.messages 上 push/replace
// (不像 pi 的 createContextSnapshot 做 slice)，每輪迭代用當下 messages 建 llmContext——
// 為「回合內真壓縮」(階段二)鋪路。階段一行為先對齊 pi。

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const DEFAULT_MODEL = {
  id: 'unknown', name: 'unknown', api: 'unknown', provider: 'unknown', baseUrl: '',
  reasoning: false, input: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0, maxTokens: 0,
};

// 預設：送給 LLM 的訊息過濾成 user/assistant/toolResult
function defaultConvertToLlm(messages) {
  return messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult');
}
const errResult = (msg) => ({ content: [{ type: 'text', text: msg }], details: {} });

// steering / followUp 佇列(預設 one-at-a-time)
class Queue {
  constructor(mode = 'one-at-a-time') { this.mode = mode; this.items = []; }
  enqueue(m) { this.items.push(m); }
  hasItems() { return this.items.length > 0; }
  drain() {
    if (this.mode === 'all') { const d = this.items; this.items = []; return d; }
    return this.items.length ? [this.items.shift()] : [];
  }
  clear() { this.items = []; }
}

export class Agent {
  constructor(options = {}) {
    const init = options.initialState || {};
    let messages = (init.messages || []).slice();
    let tools = (init.tools || []).slice();
    this._state = {
      systemPrompt: init.systemPrompt ?? '',
      model: init.model ?? DEFAULT_MODEL,
      thinkingLevel: init.thinkingLevel ?? 'off',
      get tools() { return tools; },
      set tools(v) { tools = (v || []).slice(); },
      get messages() { return messages; },        // getter 回 live 陣列；可直接 push/replace
      set messages(v) { messages = (v || []).slice(); }, // setter 才 slice(對齊 pi)
      isStreaming: false,
      streamingMessage: undefined,
      errorMessage: undefined,
    };
    this.listeners = new Set();
    this.streamFn = options.streamFn;               // 必傳(xitto 都注入；缺則無法串流)
    this.maxSteps = options.maxSteps || 80;          // 單回合硬上限：防 agent 無限呼叫工具繞圈
    this.getApiKey = options.getApiKey;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.onPayload = options.onPayload;
    this.thinkingBudgets = options.thinkingBudgets; // 可選：{minimal,low,medium,high}→思考 token 預算（anthropic 端點才生效）
    this.convertToLlm = options.convertToLlm || defaultConvertToLlm;
    // 回合內真壓縮鉤子(可選)：async () => info|null。每次串流前呼叫，可就地改寫 this._state.messages。
    // pi-agent-core 因 snapshot 做不到回合中途壓縮；自寫 loop 直接操作 live messages，故此鉤子有效。
    this.maybeCompactInTurn = options.maybeCompactInTurn;
    this.toolExecution = options.toolExecution || 'parallel';
    this.steeringQueue = new Queue(options.steeringMode);
    this.followUpQueue = new Queue(options.followUpMode);
    this.activeRun = undefined;
  }

  get state() { return this._state; }
  get signal() { return this.activeRun?.abortController.signal; }
  subscribe(l) { this.listeners.add(l); return () => this.listeners.delete(l); }
  steer(m) { this.steeringQueue.enqueue(m); }
  followUp(m) { this.followUpQueue.enqueue(m); }
  abort() { this.activeRun?.abortController.abort(); }
  waitForIdle() { return this.activeRun?.promise ?? Promise.resolve(); }
  reset() {
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;
    this.steeringQueue.clear();
    this.followUpQueue.clear();
  }

  // 依序 await 所有 listener(對齊 pi processEvents)；同時維護 streamingMessage
  async emit(event) {
    if (event.type === 'message_start' || event.type === 'message_update') this._state.streamingMessage = event.message;
    else if (event.type === 'message_end' || event.type === 'agent_end') this._state.streamingMessage = undefined;
    else if (event.type === 'turn_end' && event.message?.errorMessage) this._state.errorMessage = event.message.errorMessage;
    const signal = this.activeRun?.abortController.signal;
    for (const l of this.listeners) await l(event, signal);
  }

  async prompt(input) {
    if (this.activeRun) throw new Error('Agent is already processing a prompt. Use steer()/followUp() or wait.');
    let msgs;
    if (Array.isArray(input)) msgs = input;
    else if (typeof input === 'string') msgs = [{ role: 'user', content: [{ type: 'text', text: input }], timestamp: Date.now() }];
    else msgs = [input];
    await this.runWithLifecycle((signal) => this.runLoop(msgs, signal));
  }

  async runWithLifecycle(executor) {
    const abortController = new AbortController();
    let resolve = () => {};
    const promise = new Promise((r) => { resolve = r; });
    this.activeRun = { promise, resolve, abortController };
    this._state.isStreaming = true;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;
    try { await executor(abortController.signal); }
    catch (err) { await this.handleRunFailure(err, abortController.signal.aborted); }
    finally {
      this._state.isStreaming = false;
      this._state.streamingMessage = undefined;
      this.activeRun?.resolve();
      this.activeRun = undefined;
    }
  }

  async handleRunFailure(error, aborted) {
    const m = this._state.model;
    const failureMessage = {
      role: 'assistant', content: [{ type: 'text', text: '' }],
      api: m.api, provider: m.provider, model: m.id, usage: EMPTY_USAGE,
      stopReason: aborted ? 'aborted' : 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    this._state.messages.push(failureMessage);
    this._state.errorMessage = failureMessage.errorMessage;
    await this.emit({ type: 'agent_end', messages: [failureMessage] });
  }

  // 主迴圈(對齊 spec §6)
  async runLoop(initialMessages, signal) {
    const newMessages = [];
    let pending = initialMessages.slice();
    let firstTurn = true;
    let steps = 0;
    while (true) {
      let hasMoreToolCalls = true;
      while (hasMoreToolCalls || pending.length) {
        if (!firstTurn) await this.emit({ type: 'turn_start' }); else firstTurn = false;
        for (const m of pending) {
          await this.emit({ type: 'message_start', message: m });
          await this.emit({ type: 'message_end', message: m });
          this._state.messages.push(m); newMessages.push(m);
        }
        pending = [];

        // abort 守衛：迴圈邊界若已中止，立即走 handleRunFailure(aborted)。
        // 真實 provider 由 fetch signal 中止串流；此守衛確保 fake/工具觸發的 abort 也確定性收尾。
        if (signal.aborted) throw new Error('Aborted');
        // 硬上限：單回合工具呼叫太多 → 注入一句「別再用工具,直接用現有資訊作結」,逼它收尾
        if (steps === this.maxSteps - 1) this._state.messages.push({ role: 'user', content: [{ type: 'text', text: `[系統] 已達工具呼叫上限（${this.maxSteps} 步）。請停止使用任何工具，直接根據目前已知資訊給出結論或說明卡在哪、缺什麼，然後結束。` }] });
        if (steps >= this.maxSteps) { await this.emit({ type: 'agent_end', messages: newMessages }); return; }
        steps++;
        const message = await this.streamAssistant(signal);
        newMessages.push(message);
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          await this.emit({ type: 'turn_end', message, toolResults: [] });
          await this.emit({ type: 'agent_end', messages: newMessages });
          return;
        }
        const toolCalls = (message.content || []).filter((c) => c.type === 'toolCall');
        const toolResults = [];
        hasMoreToolCalls = false;
        if (toolCalls.length) {
          const batch = await this.executeTools(message, toolCalls, signal);
          for (const r of batch.messages) { this._state.messages.push(r); newMessages.push(r); toolResults.push(r); }
          hasMoreToolCalls = !batch.terminate;
        }
        await this.emit({ type: 'turn_end', message, toolResults });
        pending = this.steeringQueue.drain();
        // 回合邊界套用了使用者中途插話（steering）→ 發事件，讓前端把插話後的回覆分到新泡泡（CC 式體驗）
        if (pending.length) await this.emit({ type: 'steered_applied', messages: pending });
      }
      const followUps = this.followUpQueue.drain();
      if (followUps.length) { pending = followUps; continue; }
      break;
    }
    await this.emit({ type: 'agent_end', messages: newMessages });
  }

  // 串流一次 assistant 回應(消費 streamFn 事件)。用 live messages 建 llmContext。
  async streamAssistant(signal) {
    // 回合內真壓縮：串流前若上下文逼近上限，就地壓縮 live this._state.messages 後續跑同一回合。
    // 失敗不阻斷回合(由上層熔斷 fallback 兜底)。這是自寫 loop 相對 pi-agent-core 的核心優勢。
    if (this.maybeCompactInTurn) {
      try { await this.maybeCompactInTurn(); } catch { /* 壓縮失敗不應阻斷回合 */ }
    }
    const llmMessages = await this.convertToLlm(this._state.messages);
    const llmContext = { systemPrompt: this._state.systemPrompt, messages: llmMessages, tools: this._state.tools };
    const apiKey = this.getApiKey ? await this.getApiKey(this._state.model.provider) : undefined;
    const opts = {
      model: this._state.model,
      reasoning: this._state.thinkingLevel === 'off' ? undefined : this._state.thinkingLevel,
      ...(this.thinkingBudgets ? { thinkingBudgets: this.thinkingBudgets } : {}), // 每級思考預算（anthropic 端點）
      transport: 'sse',
      onPayload: this.onPayload,
      toolExecution: this.toolExecution,
      apiKey,
      signal,
    };
    const response = await this.streamFn(this._state.model, llmContext, opts);

    let partial = null;
    let addedPartial = false;
    const finalize = async () => {
      const finalMessage = await response.result();
      if (addedPartial) this._state.messages[this._state.messages.length - 1] = finalMessage;
      else { this._state.messages.push(finalMessage); await this.emit({ type: 'message_start', message: { ...finalMessage } }); }
      await this.emit({ type: 'message_end', message: finalMessage });
      return finalMessage;
    };

    for await (const event of response) {
      switch (event.type) {
        case 'start':
          partial = event.partial; this._state.messages.push(partial); addedPartial = true;
          await this.emit({ type: 'message_start', message: { ...partial } });
          break;
        case 'text_start': case 'text_delta': case 'text_end':
        case 'thinking_start': case 'thinking_delta': case 'thinking_end':
        case 'toolcall_start': case 'toolcall_delta': case 'toolcall_end':
          if (partial) {
            partial = event.partial;
            this._state.messages[this._state.messages.length - 1] = partial;
            await this.emit({ type: 'message_update', assistantMessageEvent: event, message: { ...partial } });
          }
          break;
        case 'done': case 'error':
          return finalize();
        default:
          break;
      }
    }
    return finalize(); // 串流自然結束(無 done/error)
  }

  // 執行一批 tool call(sequential：xitto 用；parallel 亦支援)
  async executeTools(assistantMessage, toolCalls, signal) {
    const sequential = this.toolExecution === 'sequential'
      || toolCalls.some((tc) => this._state.tools.find((t) => t.name === tc.name)?.executionMode === 'sequential');

    const runOne = async (toolCall) => {
      await this.emit({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
      const prep = await this.prepareTool(assistantMessage, toolCall, signal);
      let result; let isError;
      if (prep.kind === 'immediate') { result = prep.result; isError = prep.isError; }
      else {
        try {
          result = await prep.tool.execute(toolCall.id, prep.args, signal, (partialResult) => {
            this.emit({ type: 'tool_execution_update', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments, partialResult });
          });
          isError = false;
        } catch (e) { result = errResult(e instanceof Error ? e.message : String(e)); isError = true; }
      }
      if (result == null || typeof result !== 'object') result = errResult('工具未回傳有效結果');
      await this.emit({ type: 'tool_execution_end', toolCallId: toolCall.id, toolName: toolCall.name, result, isError });
      const trMsg = {
        role: 'toolResult', toolCallId: toolCall.id, toolName: toolCall.name,
        content: result.content, details: result.details, isError, timestamp: Date.now(),
      };
      return { result, trMsg };
    };

    let finalized;
    if (sequential) {
      finalized = [];
      for (const tc of toolCalls) finalized.push(await runOne(tc));
    } else {
      finalized = await Promise.all(toolCalls.map(runOne));
    }
    const terminate = finalized.length > 0 && finalized.every((f) => f.result.terminate === true);
    return { messages: finalized.map((f) => f.trMsg), terminate };
  }

  async prepareTool(assistantMessage, toolCall, signal) {
    const tool = this._state.tools.find((t) => t.name === toolCall.name);
    if (!tool) return { kind: 'immediate', result: errResult(`Tool ${toolCall.name} not found`), isError: true };
    try {
      const args = toolCall.arguments; // pi-ai 已解析；工具層另有 coerceArgs 包裝
      if (this.beforeToolCall) {
        const ctx = { assistantMessage, toolCall, args, context: { systemPrompt: this._state.systemPrompt, messages: this._state.messages, tools: this._state.tools } };
        const before = await this.beforeToolCall(ctx, signal);
        if (before?.block) return { kind: 'immediate', result: errResult(before.reason || 'Tool execution was blocked'), isError: true };
      }
      return { kind: 'prepared', toolCall, tool, args };
    } catch (e) {
      return { kind: 'immediate', result: errResult(e instanceof Error ? e.message : String(e)), isError: true };
    }
  }
}
