// 目標驅動自主循環 — kernel 內建（領域無關）。給目標 → 反覆 runTurn + LLM 自我驗收，
// 直到達成 / 到上限 / 無進展。對標 xitto-code 的 /loop。checkGoal 用 LLM 判斷是否完成。
import { completeSimple } from '@mariozechner/pi-ai';
import { cacheRetentionFor } from './provider.js';

const JUDGE_SYS = '你是嚴格的驗收員。依「目標」與「對話進展」判斷目標是否已達成。' +
  '只輸出 JSON：{"done": true|false, "remaining": "若未達成，還差什麼（一句）"}。不要任何多餘文字。';

const asText = (m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : String(m?.content || ''));

export function normalizeFeedback(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

/**
 * 用 LLM 判斷目標是否達成。回 { done, remaining, error? }；任何失敗都保守回 done:false（續跑）。
 */
export async function checkGoal(goal, messages, model, apiKey, signal) {
  if (!apiKey) return { done: false, remaining: '(無 API key)', error: true };
  const recent = messages.slice(-8).map((m) => `${m.role}: ${asText(m).slice(0, 800)}`).join('\n').slice(0, 6000);
  const ctx = {
    systemPrompt: JUDGE_SYS,
    messages: [{ role: 'user', content: [{ type: 'text', text: `目標：\n${goal}\n\n對話進展：\n${recent}\n\n是否已達成？只輸出 JSON。` }], timestamp: Date.now() }],
  };
  try {
    const res = await completeSimple(model, ctx, { maxTokens: 220, apiKey, signal, cacheRetention: cacheRetentionFor(model) });
    if (res.stopReason === 'error') return { done: false, remaining: '(驗收呼叫失敗)', error: true };
    const t = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return { done: false, remaining: '(驗收輸出無法解析)', error: true };
    const o = JSON.parse(m[0]);
    return { done: !!o.done, remaining: String(o.remaining || '') };
  } catch (e) { return { done: false, remaining: `(驗收例外:${e?.message || e})`, error: true }; }
}
