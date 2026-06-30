// 子 agent（spawn）— kernel 內建能力。派一個「唯讀」子 agent 做聚焦調查，回傳結論文字，
// 不把中間工具呼叫污染主對話。對標 Claude Code 的 Task / xitto-code 的 spawn_agent。
// 子 agent 只拿唯讀工具，故不需守衛/沙箱（無副作用）。
const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

const SUB_PROMPT =
  '你是唯讀調查子 agent。只用提供的唯讀工具（讀檔/搜尋/列目錄/記憶）查證，不臆測、不杜撰；' +
  '查完後用簡潔文字把結論總結給主 agent（含關鍵檔案/行號/事實），不要長篇大論。';

/**
 * @param {Object} o
 * @param {() => object} o.getModel
 * @param {(provider: string) => string|Promise<string>} o.getApiKey
 * @param {() => import('../types.js').Tool[]} o.getReadOnlyTools  子 agent 可用的唯讀工具集（不含 spawn_agent 自己）
 */
export function createSpawnTool({ getModel, getApiKey, getReadOnlyTools }) {
  return {
    name: 'spawn_agent', label: '子 agent', readOnly: true,
    description: '派一個唯讀子 agent 做聚焦調查（讀檔/搜尋/分析），回傳結論文字。'
      + '適合：需要深入查證一個子問題、但不想讓中間步驟塞滿主對話時。子 agent 不能改檔或跑命令。',
    parameters: { type: 'object', properties: { task: { type: 'string', description: '要子 agent 調查的具體任務' } }, required: ['task'] },
    // onPartial（第 4 參數）：把子 agent 的工具活動即時轉發給主串流，讓 UI 能嵌套顯示其過程。
    execute: async (_id, { task }, _signal, onPartial) => {
      const model = getModel?.();
      if (!model || !getApiKey) return txt({ error: '無 model/apiKey，無法派子 agent' });
      const { Agent } = await import('./agent-loop.js');
      const { defaultStreamFn } = await import('./provider.js');
      const sub = new Agent({
        initialState: {
          systemPrompt: SUB_PROMPT,
          model,
          tools: getReadOnlyTools(),
          thinkingLevel: model.reasoning ? 'low' : 'off',
        },
        getApiKey,
        streamFn: defaultStreamFn(),
        toolExecution: 'sequential',
      });
      // 訂閱子 agent 的工具事件＋思考文字，原樣轉發（kind: 'subagent'，主串流端據此映射）
      let textBuf = '', lastLen = 0;
      const unsub = typeof onPartial === 'function'
        ? sub.subscribe((ev) => {
            if (ev.type === 'tool_execution_start') {
              textBuf = ''; lastLen = 0; // 進入工具動作，重置思考緩衝
              onPartial({ kind: 'subagent', phase: 'start', name: ev.toolName, args: ev.args });
            } else if (ev.type === 'tool_execution_end') {
              onPartial({ kind: 'subagent', phase: 'end', name: ev.toolName, isError: !!ev.isError });
            } else if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
              textBuf = (textBuf + (ev.assistantMessageEvent.delta || '')).slice(-400);
              if (textBuf.length - lastLen >= 6) { // 輕量節流：每累積 ~6 字才送一次
                lastLen = textBuf.length;
                onPartial({ kind: 'subagent', phase: 'think', text: textBuf.replace(/\s+/g, ' ').trim().slice(-160) });
              }
            }
          })
        : null;
      try {
        await sub.prompt(String(task || ''));
        const last = [...sub.state.messages].reverse().find((m) => m.role === 'assistant');
        const text = (last?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        return txt(text || '(子 agent 無輸出)');
      } catch (e) { return txt({ error: e?.message || String(e) }); }
      finally { unsub?.(); }
    },
  };
}
