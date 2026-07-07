// 對話模式「即時插話」(CC 式 steering) — 回合邊界插入使用者訊息，agent 不重啟就接手，
// 並發 steered_applied 事件讓前端把插話後的回覆分到新泡泡。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/kernel/agent-loop.js';
import { mapEvent, createServerApp } from '../src/app/server.js';

const MODEL = { id: 'x', provider: 'x', api: 'openai-completions', baseUrl: '', contextWindow: 1000, maxTokens: 100, cost: {} };
const asstMsg = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }], stopReason: 'stop', api: 'openai-completions', provider: 'x', model: 'x', usage: {}, timestamp: 1 });
const streamOf = (m) => { const s = new AssistantMessageEventStream(); s.push({ type: 'start', partial: m }); s.push({ type: 'done', reason: 'stop', message: m }); return s; };

test('kernel steering：回合邊界插話 → 套用、發 steered_applied、產生後續回覆（不重啟）', async () => {
  const turns = [asstMsg('回覆1'), asstMsg('回覆2')];
  let i = 0;
  const events = [];
  const agent = new Agent({
    initialState: { systemPrompt: '', model: MODEL, tools: [], messages: [] },
    streamFn: async () => streamOf(turns[Math.min(i++, turns.length - 1)]),
  });
  let steeredOnce = false;
  agent.subscribe((e) => {
    events.push(e.type);
    // 第一輪收尾時插話一次（模擬使用者回覆中送出）
    if (e.type === 'turn_end' && !steeredOnce) { steeredOnce = true; agent.steer({ role: 'user', content: [{ type: 'text', text: '改用條列' }] }); }
  });
  await agent.prompt('原始問題');

  assert.ok(events.includes('steered_applied'), '有發 steered_applied 事件');
  const userTexts = agent.state.messages.filter((m) => m.role === 'user').map((m) => m.content.map((c) => c.text).join(''));
  assert.deepEqual(userTexts, ['原始問題', '改用條列'], '插話訊息進了對話（在原始問題之後）');
  const asstTexts = agent.state.messages.filter((m) => m.role === 'assistant').map((m) => (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
  assert.deepEqual(asstTexts, ['回覆1', '回覆2'], '插話後 agent 於同一輪運行內產生後續回覆');
});

test('無插話：不發 steered_applied（一般回合不受影響）', async () => {
  const events = [];
  const agent = new Agent({ initialState: { systemPrompt: '', model: MODEL, tools: [], messages: [] }, streamFn: async () => streamOf(asstMsg('只回一次')) });
  agent.subscribe((e) => events.push(e.type));
  await agent.prompt('嗨');
  assert.ok(!events.includes('steered_applied'), '沒插話就不該發 steered_applied');
});

test('mapEvent：steered_applied → { type:steered, texts:[...] }（多段文字併接、取 user）', () => {
  assert.deepEqual(
    mapEvent({ type: 'steered_applied', messages: [{ role: 'user', content: [{ type: 'text', text: '插話A' }] }] }),
    { type: 'steered', texts: ['插話A'] },
  );
  // 非 user 訊息略過；content 為多段時併接
  assert.deepEqual(
    mapEvent({ type: 'steered_applied', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }, { role: 'user', content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] }] }),
    { type: 'steered', texts: ['甲乙'] },
  );
});

test('HTTP /v1/stream/steer：需授權；空 text→400；無 live agent→injected:false（前端退回排隊）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steer-'));
  const app = createServerApp({ model: { id: 'm', name: 'M', provider: 'p' }, getApiKey: () => 'k', token: 't', baseDir: dir });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port, U = (p) => `http://127.0.0.1:${port}${p}`;
  const H = { 'content-type': 'application/json', authorization: 'Bearer t' };
  try {
    assert.equal((await fetch(U('/v1/stream/steer'), { method: 'POST', body: JSON.stringify({ key: 'x', text: 'hi' }) })).status, 401, '無 token → 401');
    assert.equal((await fetch(U('/v1/stream/steer'), { method: 'POST', headers: H, body: JSON.stringify({ key: 'x', text: '' }) })).status, 400, '空 text → 400');
    const r = await fetch(U('/v1/stream/steer'), { method: 'POST', headers: H, body: JSON.stringify({ key: 'no-such', text: '插話' }) }).then((x) => x.json());
    assert.equal(r.injected, false, '找不到 live agent → injected:false');
  } finally { await new Promise((r) => app.close(r)); rmSync(dir, { recursive: true, force: true }); }
});
