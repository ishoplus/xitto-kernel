// 答案格式化 pass（agent scaffold 的一部分，非評分器）：把 agent 的完整回答濃縮成
// 嚴格符合 GAIA 格式的最終答案——只修「內容對、格式錯」的近似失分（贅字 / list 排序 / 冠詞），
// 答錯的題救不回來（不會虛胖分數）。用一次輕量 completeSimple 呼叫。
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { cacheRetentionFor } from '../../src/kernel/provider.js';

const SYS = `You extract the single FINAL ANSWER from an assistant's response to a question, and reformat it to match the required answer format exactly.
Output ONLY the answer on one line — no "FINAL ANSWER:", no quotes, no explanation, no trailing punctuation.
Rules:
- The answer is a number OR as few words as possible OR a comma separated list.
- Number: no thousands commas, no units ($, %) unless the question explicitly asks for them; digits only.
- String: no articles (a/an/the), no abbreviations, write digits in plain text unless the question specifies otherwise; give the MINIMAL exact name/phrase the question asks for — strip surrounding formatting or extra descriptors the question did not ask for.
- Comma separated list: apply the number/string rules to each element, use EXACTLY the ordering the question requests (e.g. alphabetical, or as-they-appear); separate elements with ", ".
- Do NOT invent an answer. If the response clearly failed to answer, output the response's own stated final answer verbatim (still stripped of the "FINAL ANSWER:" label).`;

export async function formatAnswer({ model, getApiKey, question, response, signal }) {
  const apiKey = getApiKey ? await getApiKey(model.provider) : undefined;
  const user = `QUESTION:\n${question}\n\nASSISTANT RESPONSE (may include reasoning; the final answer is usually near the end):\n${String(response || '').slice(-4000)}\n\nReformatted final answer (one line only):`;
  const ctx = { systemPrompt: SYS, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], tools: [] };
  // maxTokens 要夠大：MiniMax 等推理模型一定先產 thinking，token 太少會全被 thinking 吃光、吐不出 text。
  const res = await completeSimple(model, ctx, { maxTokens: 2000, apiKey, signal, cacheRetention: cacheRetentionFor(model) });
  const t = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  // 保險：剝掉可能殘留的標籤/粗體，取最後一非空行
  const cleaned = t.replace(/\*\*/g, '').replace(/^\s*FINAL ANSWER:?\s*/i, '');
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  return last.replace(/^\s*FINAL ANSWER:?\s*/i, '').replace(/[.]+$/, '').trim(); // 空字串 → 由呼叫端退回 answerRaw
}

// 便利包裝：格式化失敗或回空 → 退回原始抽取答案，保證永不比 raw 更差。
export async function formatOrFallback(args, fallback) {
  try { const f = await formatAnswer(args); return f && f.trim() ? f : fallback; }
  catch { return fallback; }
}
