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
    execute: async (_id, { task }) => {
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
      try {
        await sub.prompt(String(task || ''));
        const last = [...sub.state.messages].reverse().find((m) => m.role === 'assistant');
        const text = (last?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        return txt(text || '(子 agent 無輸出)');
      } catch (e) { return txt({ error: e?.message || String(e) }); }
    },
  };
}
