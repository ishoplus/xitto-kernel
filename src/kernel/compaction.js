// 回合內上下文壓縮 — kernel 內建。上下文逼近 model 視窗時，把較舊對話摘要成一段、保留最近數輪，
// 避免長對話爆窗。對標 xitto-code compaction.js（自足版：以字元/4 粗估 tokens，不依賴 pi-coding-agent）。
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { cacheRetentionFor } from './provider.js';

export const DEFAULT_COMPACTION = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

const asText = (m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : String(m?.content || ''));
const estimateTokens = (m) => { try { return Math.ceil(JSON.stringify(m.content ?? m).length / 4); } catch { return 0; } };
const totalTokens = (messages) => messages.reduce((s, m) => s + estimateTokens(m), 0);
const shouldCompact = (tokens, win, s) => s.enabled !== false && tokens > (win || 32000) - (s.reserveTokens || DEFAULT_COMPACTION.reserveTokens);

export function isContextOverThreshold(messages, win, s = DEFAULT_COMPACTION) {
  return shouldCompact(totalTokens(messages), win, s);
}

// 切點：從最新往回累加，達 keepRecentTokens 後切在最近的 user 訊息邊界（保留完整輪次）
export function findCutIndex(messages, keepRecent) {
  let acc = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    acc += estimateTokens(messages[i]);
    if (acc >= keepRecent && messages[i].role === 'user') return i;
  }
  return -1;
}

async function summarize(older, model, reserveTokens, apiKey) {
  const text = older.map((m) => `${m.role}: ${asText(m).slice(0, 1500)}`).join('\n').slice(0, 24000);
  const ctx = {
    systemPrompt: '把以下對話濃縮成要點摘要：決策、已確認的事實、待辦、檔案/狀態改動，供後續延續。用對話本身的語言書寫。只輸出摘要本身。',
    messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }],
  };
  const res = await completeSimple(model, ctx, { maxTokens: Math.floor(0.8 * (reserveTokens || 2000)), apiKey, cacheRetention: cacheRetentionFor(model) });
  if (res.stopReason === 'error') return null;
  return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}

// 就地壓縮 agent.state.messages。回 info（壓了）/ null（未達閾值）/ {error}（摘要失敗）。
export async function maybeCompact(agent, model, apiKey, settings = DEFAULT_COMPACTION) {
  const messages = agent.state.messages;
  const tokens = totalTokens(messages);
  if (!shouldCompact(tokens, model.contextWindow || 32000, settings)) return null;
  const cut = findCutIndex(messages, settings.keepRecentTokens || DEFAULT_COMPACTION.keepRecentTokens);
  if (cut <= 0) return null; // 切不動（最近輪次已佔滿）→ 交由上層熔斷
  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);
  let summary;
  try { summary = await summarize(older, model, settings.reserveTokens, apiKey); } catch { return { error: true }; }
  if (!summary) return { error: true };
  const summaryMsg = { role: 'user', content: [{ type: 'text', text: `# 先前對話摘要（已壓縮）\n${summary}` }], timestamp: Date.now() };
  agent.state.messages = [summaryMsg, ...recent];
  return { tokensBefore: tokens, tokensAfter: totalTokens(agent.state.messages), summarized: older.length, kept: recent.length };
}

// 正規化設定 + 安全 clamp（reserve+keepRecent 不逼近視窗，否則永遠切不動）
export function resolveCompactionSettings(override = {}, contextWindow) {
  const s = { ...DEFAULT_COMPACTION, ...(override || {}) };
  const win = (Number.isFinite(contextWindow) && contextWindow > 0) ? contextWindow : null;
  if (win) {
    const cap = Math.floor(win * 0.9);
    if (s.reserveTokens > cap) s.reserveTokens = cap;
    if (s.reserveTokens + s.keepRecentTokens > cap) s.keepRecentTokens = Math.max(0, cap - s.reserveTokens);
  }
  return s;
}
