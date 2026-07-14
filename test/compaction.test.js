// 回合內壓縮 — 純邏輯：閾值判斷、切點、設定 clamp（摘要的 LLM 呼叫不在單測範圍）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isContextOverThreshold, findCutIndex, resolveCompactionSettings, maybeCompact, compactNow } from '../src/kernel/compaction.js';

const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });
const big = (n) => msg('user', 'x'.repeat(n));

test('isContextOverThreshold：小視窗→超過；大視窗→未超', () => {
  const messages = [big(40000)]; // ~10k tokens
  assert.equal(isContextOverThreshold(messages, 8000, { enabled: true, reserveTokens: 2000 }), true);
  assert.equal(isContextOverThreshold(messages, 1000000, { enabled: true, reserveTokens: 2000 }), false);
});

test('isContextOverThreshold：enabled:false → 永不壓', () => {
  assert.equal(isContextOverThreshold([big(400000)], 8000, { enabled: false }), false);
});

test('findCutIndex：保留最近、切在 user 邊界', () => {
  const messages = [msg('user', 'q1'), msg('assistant', 'a1'), big(40000), msg('user', 'q2'), msg('assistant', 'a2')];
  const cut = findCutIndex(messages, 100); // keepRecent 很小 → 切在最近的 user(q2, index 3)
  assert.equal(messages[cut].role, 'user');
  assert.ok(cut >= 1);
});

test('resolveCompactionSettings：clamp reserve+keep 不逼近視窗', () => {
  const s = resolveCompactionSettings({ reserveTokens: 99999, keepRecentTokens: 99999 }, 10000);
  assert.ok(s.reserveTokens + s.keepRecentTokens <= Math.floor(10000 * 0.9));
});

test('maybeCompact：未達閾值 → null（不呼叫 LLM）', async () => {
  const agent = { state: { messages: [msg('user', 'hi')] } };
  const r = await maybeCompact(agent, { contextWindow: 1000000 }, () => 'k', { enabled: true, reserveTokens: 2000, keepRecentTokens: 2000 });
  assert.equal(r, null);
});

test('compactNow：訊息太少 → nothing-to-compact（不呼叫 LLM）', async () => {
  assert.equal((await compactNow([], { contextWindow: 1000 }, 'k')).error, 'nothing-to-compact');
  assert.equal((await compactNow([msg('user', 'hi')], { contextWindow: 1000 }, 'k')).error, 'nothing-to-compact');
});
