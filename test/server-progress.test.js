// 進度可見性：mapEvent 新事件（round/verify）+ 任務 progress 累積（給 UI「正在做什麼」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStore, mapEvent } from '../src/app/server.js';

const tick = () => new Promise((r) => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('mapEvent：session_start → session 事件（串流首事件送 sessionId，讓新對話即時進側欄）', () => {
  assert.deepEqual(mapEvent({ type: 'session_start', sessionId: 'abc123' }), { type: 'session', sessionId: 'abc123' });
});

test('mapEvent：round / verify 事件 → 進度事件', () => {
  assert.deepEqual(mapEvent({ type: 'round', round: 2, maxRounds: 12 }), { type: 'round', round: 2, maxRounds: 12 });
  assert.deepEqual(mapEvent({ type: 'verify_start' }), { type: 'phase', phase: 'verifying' });
  assert.deepEqual(mapEvent({ type: 'verify_end', ok: true }), { type: 'phase', phase: 'verified' });
  assert.deepEqual(mapEvent({ type: 'verify_end', ok: false }), { type: 'phase', phase: 'fixing' });
});

test('mapEvent：message_end 帶 usage → token 用量事件（給 UI 即時計數）', () => {
  assert.deepEqual(mapEvent({ type: 'message_end', message: { usage: { input: 120, output: 45 } } }), { type: 'usage', input: 120, output: 45 });
  // 無 usage（或無 message）仍為 null，不污染串流
  assert.equal(mapEvent({ type: 'message_end' }), null);
  assert.equal(mapEvent({ type: 'message_end', message: {} }), null);
});

test('progress：從事件累積 round / steps / recent / phase，完成轉 done', async () => {
  const gate = defer();
  const store = createTaskStore({
    runJob: async (spec, emit) => {
      emit({ type: 'round', round: 1, maxRounds: 12 });
      emit({ type: 'tool', name: 'read', args: { path: 'a.js' } });
      emit({ type: 'tool', name: 'bash', args: { command: 'npm test' } });
      emit({ type: 'phase', phase: 'verifying' });
      await gate.promise;
      return { text: 'ok' };
    },
  });
  const t = store.enqueue({ mode: 'goal', goal: 'x' });
  await tick(); await tick();
  const p = store.view(t.id).progress;
  assert.equal(p.round, 1);
  assert.equal(p.maxRounds, 12);
  assert.equal(p.steps, 2);
  assert.equal(p.phase, 'verifying');
  assert.deepEqual(p.recent.map((r) => r.name), ['read', 'bash']);
  gate.resolve(); await tick(); await tick();
  assert.equal(store.view(t.id).progress.phase, 'done');
});

test('progress：text 事件累積 thinking（思考可見）；tool/round 後清空', async () => {
  const gate = defer();
  const store = createTaskStore({
    runJob: async (spec, emit) => {
      emit({ type: 'text', delta: '我打算先' });
      emit({ type: 'text', delta: '讀檔再修改' });
      await gate.promise;
      return {};
    },
  });
  const t = store.enqueue({});
  await tick(); await tick();
  let p = store.view(t.id).progress;
  assert.equal(p.phase, 'thinking');
  assert.match(p.thinking, /讀檔再修改/);
  gate.resolve();
});

test('mapEvent：tool_end 帶 diff（給網頁彩色 diff）', () => {
  const d = { added: 1, removed: 1, lines: [{ t: '-', s: 'a' }, { t: '+', s: 'b' }] };
  assert.deepEqual(mapEvent({ type: 'tool_execution_end', toolName: 'edit', isError: false, result: { content: [], _diff: d } }), { type: 'tool_end', name: 'edit', isError: false, diff: d });
  assert.equal(mapEvent({ type: 'tool_execution_end', toolName: 'bash', isError: false, result: { content: [] } }).diff, undefined);
});

test('progress：log 累積完整步驟,tool_end 補 diff/isError（給「展開過程」）', async () => {
  const gate = defer();
  const diff = { added: 1, removed: 1, lines: [{ t: '-', s: 'old' }, { t: '+', s: 'new' }] };
  const store = createTaskStore({
    runJob: async (spec, emit) => {
      emit({ type: 'tool', name: 'read', args: { path: 'a.js' } });
      emit({ type: 'tool_end', name: 'read', isError: false });
      emit({ type: 'tool', name: 'edit', args: { path: 'a.js' } });
      emit({ type: 'tool_end', name: 'edit', isError: false, diff });
      await gate.promise; return {};
    },
  });
  const t = store.enqueue({});
  await tick(); await tick();
  const log = store.view(t.id).progress.log;
  assert.equal(log.length, 2);
  assert.equal(log[0].name, 'read');
  assert.equal(log[1].name, 'edit');
  assert.equal(log[1].summary, 'a.js');
  assert.deepEqual(log[1].diff, diff);   // 編輯步驟帶 diff
  assert.equal(log[0].diff, undefined);  // 讀檔沒 diff
  gate.resolve();
});

test('progress：recent 只保留最近 6 個動作', async () => {
  const gate = defer();
  const store = createTaskStore({
    runJob: async (spec, emit) => { for (let i = 0; i < 10; i++) emit({ type: 'tool', name: 't' + i, args: {} }); await gate.promise; return {}; },
  });
  const t = store.enqueue({});
  await tick(); await tick();
  const p = store.view(t.id).progress;
  assert.equal(p.steps, 10);
  assert.equal(p.recent.length, 6);
  assert.equal(p.recent[5].name, 't9');   // 最後一個
  gate.resolve();
});
