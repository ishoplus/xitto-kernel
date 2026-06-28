// 背景任務佇列：狀態轉移、限流、事件緩衝、完成回呼（webhook 用 onFinish 模擬）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStore, mapEvent } from '../src/app/server.js';

const tick = () => new Promise((r) => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('mapEvent 壓縮 kernel 事件為對外事件', () => {
  assert.deepEqual(mapEvent({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } }), { type: 'tool', name: 'bash', args: { command: 'ls' } });
  assert.deepEqual(mapEvent({ type: 'tool_execution_end', toolName: 'bash', isError: true }), { type: 'tool_end', name: 'bash', isError: true, diff: undefined });
  assert.deepEqual(mapEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }), { type: 'text', delta: 'hi' });
  assert.equal(mapEvent({ type: 'message_end' }), null);
});

test('任務：queued → running → done，結果與完成回呼', async () => {
  const finished = [];
  const store = createTaskStore({
    runJob: async (spec, emit) => { emit({ type: 'text', delta: 'working' }); return { sessionId: 's1', text: 'ok:' + spec.input }; },
    onFinish: (t) => finished.push(t.id),
  });
  const t = store.enqueue({ pack: 'general', input: 'hello' });
  assert.equal(t.status, 'running'); // 有空檔即同步起跑（queued 狀態見限流測試）
  await tick(); await tick();
  const v = store.result(t.id);
  assert.equal(v.status, 'done');
  assert.equal(v.result.text, 'ok:hello');
  assert.deepEqual(finished, [t.id]);
  // 事件有被緩衝（含工作事件與終結事件）
  assert.ok(t.events.some((e) => e.type === 'text' && e.delta === 'working'));
  assert.ok(t.events.some((e) => e.type === 'end' && e.status === 'done'));
});

test('任務：runJob 拋錯 → status=error + 記錄 error', async () => {
  const store = createTaskStore({ runJob: async () => { throw new Error('boom'); } });
  const t = store.enqueue({ pack: 'general', input: 'x' });
  await tick(); await tick();
  const v = store.result(t.id);
  assert.equal(v.status, 'error');
  assert.match(v.error, /boom/);
});

test('限流：concurrency=1 時第二個任務等待', async () => {
  const d1 = defer();
  let started = 0;
  const store = createTaskStore({
    concurrency: 1,
    runJob: async (spec) => { started++; if (spec.input === 'a') await d1.promise; return { text: spec.input }; },
  });
  const a = store.enqueue({ input: 'a' });
  const b = store.enqueue({ input: 'b' });
  await tick();
  assert.equal(started, 1, '只應啟動第一個');
  assert.equal(store.get(a.id).status, 'running');
  assert.equal(store.get(b.id).status, 'queued');
  d1.resolve();
  await tick(); await tick();
  assert.equal(store.get(a.id).status, 'done');
  assert.equal(store.get(b.id).status, 'done');
  assert.equal(started, 2);
});

test('subscribe 即時收到事件 + 終結事件', async () => {
  const gate = defer();
  const store = createTaskStore({ runJob: async (spec, emit) => { emit({ type: 'tool', name: 'read' }); await gate.promise; return { text: 'done' }; } });
  const t = store.enqueue({ input: 'x' });
  await tick();
  const got = [];
  store.subscribe(t.id, (ev) => got.push(ev.type));
  gate.resolve();
  await tick(); await tick();
  assert.ok(got.includes('end'), '應收到終結事件');
});
