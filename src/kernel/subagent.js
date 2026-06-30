// 子 agent（spawn）— kernel 內建能力。派「唯讀」子 agent 做聚焦調查，回傳結論文字，
// 不把中間工具呼叫污染主對話。對標 Claude Code 的 Task / xitto-code 的 spawn_agent。
// 子 agent 只拿唯讀工具，故不需守衛/沙箱（無副作用）。
//
// 兩種形態：
//   spawn_agent  — 單一子 agent（深入查一件事）
//   spawn_agents — 平行 map（對 N 個項目同時各派一個子 agent），解鎖「大規模理解型轉換」。
const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

const SUB_PROMPT =
  '你是唯讀調查子 agent。只用提供的唯讀工具（讀檔/搜尋/列目錄/記憶）查證，不臆測、不杜撰；' +
  '查完後用簡潔文字把結論總結給主 agent（含關鍵檔案/行號/事實），不要長篇大論。';

const MAP_MAX = 16;          // 一次最多平行幾個子 agent（防爆量）
const MAP_CONCURRENCY = 4;   // 同時實際在跑的上限（避免一次打爆 provider）

// 跑一個唯讀子 agent，回傳其結論文字。onEvent（可選）收子 agent 的原始事件供轉發。
// streamFn 可注入（與 kernel 同一個 provider；測試可塞 fake），未給則用 pi-ai 預設。
// systemPrompt 可覆寫（自訂 agent 類型用）；未給則用預設唯讀調查員 SUB_PROMPT。
async function runSub({ model, getApiKey, tools, task, streamFn, systemPrompt, onEvent }) {
  const { Agent } = await import('./agent-loop.js');
  const sf = streamFn || (await import('./provider.js')).defaultStreamFn();
  const sub = new Agent({
    initialState: { systemPrompt: systemPrompt || SUB_PROMPT, model, tools, thinkingLevel: model.reasoning ? 'low' : 'off' },
    getApiKey,
    streamFn: sf,
    toolExecution: 'sequential',
  });
  const unsub = typeof onEvent === 'function' ? sub.subscribe(onEvent) : null;
  try {
    await sub.prompt(String(task || ''));
    const last = [...sub.state.messages].reverse().find((m) => m.role === 'assistant');
    return (last?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('') || '(子 agent 無輸出)';
  } finally { unsub?.(); }
}

// 有界並發池：最多 limit 個同時跑，逐一領取 items。
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// 解析 agentType → { systemPrompt, tools }：自訂類型的 prompt + 工具白名單子集。
// 未給/未知 → 預設唯讀調查員（systemPrompt=undefined → runSub 用 SUB_PROMPT）+ 全唯讀工具。
function resolveType(getAgentType, agentType, getReadOnlyTools) {
  const type = agentType && typeof getAgentType === 'function' ? getAgentType(agentType) : null;
  let tools = getReadOnlyTools();
  if (type?.tools?.length) tools = tools.filter((t) => type.tools.includes(t.name));
  return { systemPrompt: type?.systemPrompt, tools, typeName: type?.name || null };
}

/**
 * @param {Object} o
 * @param {() => object} o.getModel
 * @param {(provider: string) => string|Promise<string>} o.getApiKey
 * @param {() => import('../types.js').Tool[]} o.getReadOnlyTools  子 agent 可用的唯讀工具集（不含 spawn 自己，避免遞迴）
 */
export function createSpawnTool({ getModel, getApiKey, getReadOnlyTools, getStreamFn, getAgentType }) {
  return {
    name: 'spawn_agent', label: '子 agent', readOnly: true,
    description: '派一個唯讀子 agent 做聚焦調查（讀檔/搜尋/分析），回傳結論文字。'
      + '適合：需要深入查證一個子問題、但不想讓中間步驟塞滿主對話時。可用 agentType 委派給專長類型（見「可用的 agent 類型」）。子 agent 不能改檔或跑命令。',
    parameters: { type: 'object', properties: {
      task: { type: 'string', description: '要子 agent 調查的具體任務' },
      agentType: { type: 'string', description: '可選；指定 agent 類型（用其專屬 prompt 與工具子集）；省略則用預設唯讀調查員' },
    }, required: ['task'] },
    // onPartial（第 4 參數）：把子 agent 的工具活動與思考即時轉發給主串流，讓 UI 能嵌套顯示。
    execute: async (_id, { task, agentType }, _signal, onPartial) => {
      const model = getModel?.();
      if (!model || !getApiKey) return txt({ error: '無 model/apiKey，無法派子 agent' });
      const { systemPrompt, tools } = resolveType(getAgentType, agentType, getReadOnlyTools);
      let textBuf = '', lastLen = 0;
      const onEvent = typeof onPartial === 'function'
        ? (ev) => {
            if (ev.type === 'tool_execution_start') { textBuf = ''; lastLen = 0; onPartial({ kind: 'subagent', phase: 'start', name: ev.toolName, args: ev.args }); }
            else if (ev.type === 'tool_execution_end') onPartial({ kind: 'subagent', phase: 'end', name: ev.toolName, isError: !!ev.isError });
            else if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
              textBuf = (textBuf + (ev.assistantMessageEvent.delta || '')).slice(-400);
              if (textBuf.length - lastLen >= 6) { lastLen = textBuf.length; onPartial({ kind: 'subagent', phase: 'think', text: textBuf.replace(/\s+/g, ' ').trim().slice(-160) }); }
            }
          }
        : null;
      try { return txt(await runSub({ model, getApiKey, tools, task, systemPrompt, streamFn: getStreamFn?.(), onEvent })); }
      catch (e) { return txt({ error: e?.message || String(e) }); }
    },
  };
}

/**
 * spawn_agents — 平行 map：對多個項目同時各派一個唯讀子 agent，回傳每項結論。
 * 解鎖「對很多項目做同一種需要理解的處理」（掃 N 檔/模組/來源），量大時序列做太慢。
 * 同 deps 與 createSpawnTool。
 */
export function createMapTool({ getModel, getApiKey, getReadOnlyTools, getStreamFn, getAgentType }) {
  return {
    name: 'spawn_agents', label: '平行子 agent', readOnly: true,
    description: '派「多個」唯讀子 agent 平行各做一件聚焦調查（讀檔/搜尋/分析），回傳每項結論。'
      + `適合對很多項目做同一種需要理解的處理（如掃多個檔/模組/來源），量大序列太慢時。可用 agentType 讓整批用同一專長類型。`
      + `一次最多 ${MAP_MAX} 項、同時 ${MAP_CONCURRENCY} 個在跑。子 agent 皆唯讀、不能改檔或跑命令。`,
    parameters: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'string' }, description: '要平行調查的任務清單，每項一個子 agent（具體、可獨立完成）' },
        agentType: { type: 'string', description: '可選；整批子 agent 共用的類型（其專屬 prompt 與工具子集）；省略則用預設唯讀調查員' },
      },
      required: ['tasks'],
    },
    execute: async (_id, { tasks, agentType }, _signal, onPartial) => {
      const model = getModel?.();
      if (!model || !getApiKey) return txt({ error: '無 model/apiKey，無法派子 agent' });
      if (!Array.isArray(tasks) || !tasks.length) return txt({ error: 'tasks 需為非空字串陣列' });
      const all = tasks.map((t) => String(t || '').trim()).filter(Boolean);
      const list = all.slice(0, MAP_MAX);
      if (!list.length) return txt({ error: 'tasks 內容皆為空' });
      const dropped = all.length - list.length;
      const total = list.length;
      const { systemPrompt, tools } = resolveType(getAgentType, agentType, getReadOnlyTools);
      const streamFn = getStreamFn?.();
      const fire = (ev) => { if (typeof onPartial === 'function') onPartial(ev); };
      const results = await pool(list, MAP_CONCURRENCY, async (task, i) => {
        fire({ kind: 'mapagent', phase: 'item_start', index: i, total, task: task.slice(0, 80) });
        try {
          const text = await runSub({ model, getApiKey, tools, task, systemPrompt, streamFn });
          fire({ kind: 'mapagent', phase: 'item_done', index: i, total });
          return { task, text };
        } catch (e) {
          fire({ kind: 'mapagent', phase: 'item_done', index: i, total, isError: true });
          return { task, error: e?.message || String(e) };
        }
      });
      return txt({ count: results.length, ...(dropped ? { dropped, note: `超過上限 ${MAP_MAX}，已略過 ${dropped} 項` } : {}), results });
    },
  };
}
