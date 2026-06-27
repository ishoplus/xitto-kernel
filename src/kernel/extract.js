// 事實層自動萃取 — 每輪後用一次輕量 LLM,把「值得跨 session 記住的事實」抽出來存進記憶,
// 不再只靠 agent 自覺呼叫 memory_save。對標 xitto 的 extractMemory。非阻塞、盡力而為。
// 只萃取持久事實(偏好/身分/長期決策/穩定設定),略過一次性任務細節(那是情節層的事)。

const EXTRACT_SYSTEM = [
  '你是記憶萃取器。從對話中抽出「值得跨 session 長期記住的事實」：使用者偏好、身分、長期決策、穩定的專案設定。',
  '規則：',
  '- 只抽持久、可重用的事實；略過一次性任務細節、過程、寒暄、臨時數據。',
  '- 每條一句、自給自足（脫離上下文也看得懂）。',
  '- 已知事實（見下）不要重複，也不要抽語意重複的。',
  '- 沒有值得記的就輸出 []。',
  '只輸出 JSON 字串陣列，例如 ["使用者偏好繁體中文","專案用 pnpm 不是 npm"]。不要任何其他文字。',
].join('\n');

// 從模型輸出解析事實陣列：優先 JSON 陣列；非陣列/解析失敗 → 空（保守,避免抓雜訊）。
export function parseFacts(text) {
  if (!text) return [];
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const a = JSON.parse(m[0]);
    if (!Array.isArray(a)) return [];
    return a.map((x) => String(x).trim()).filter((x) => x.length >= 1 && x.length <= 200);
  } catch { return []; }
}

// 把最近對話壓成萃取輸入（取末端幾則 user/assistant 文字）。
function conversationText(messages) {
  return (messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => `${m.role === 'user' ? '使用者' : '助手'}：${(m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').slice(0, 800)}`)
    .filter((l) => l.length > 4)
    .join('\n');
}

// 單次 LLM 呼叫（無工具），收完整文字。沿用 kernel 的 streamFn 契約。
async function runOnce({ model, getApiKey, streamFn, systemPrompt, userText }) {
  const apiKey = getApiKey ? await getApiKey(model.provider) : undefined;
  const llmContext = { systemPrompt, messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }], tools: [] };
  const response = await streamFn(model, llmContext, { model, transport: 'sse', apiKey });
  for await (const _ of response) { /* 排空事件 */ }
  const final = await response.result();
  return (final?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

/**
 * 從對話萃取持久事實（已過濾掉 existing 中已有的）。
 * @returns {Promise<string[]>}
 */
export async function extractFacts({ model, getApiKey, streamFn, messages, existing = [] }) {
  const convo = conversationText(messages);
  if (!convo.trim()) return [];
  const sys = EXTRACT_SYSTEM + (existing.length ? `\n已知事實：\n${existing.map((e) => `- ${e}`).join('\n')}` : '');
  let text;
  try { text = await runOnce({ model, getApiKey, streamFn, systemPrompt: sys, userText: convo }); }
  catch { return []; } // 萃取失敗不影響主流程
  const have = new Set(existing.map((e) => e.trim()));
  const out = [];
  for (const f of parseFacts(text)) { if (!have.has(f) && !out.includes(f)) out.push(f); }
  return out;
}
