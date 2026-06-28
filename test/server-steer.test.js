// 中途補充（steering）：任務進行中使用者插話。串流中 → 即時排進 agent.steer；回合之間 → 緩衝給 drainSteer。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStore } from '../src/app/server.js';

const tick = () => new Promise((r) => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('steer：agent 串流中 → 即時排進 steeringQueue（不緩衝）+ 進度回饋', async () => {
  const gate = defer();
  const steered = [];
  const store = createTaskStore({
    runJob: async (spec, emit, ask, onAgent) => {
      onAgent({ state: { isStreaming: true }, steer: (m) => steered.push(m) }); // 模擬串流中的 agent
      await gate.promise;
      return { text: 'ok' };
    },
  });
  const t = store.enqueue({ mode: 'goal', goal: 'x' });
  await tick(); await tick();
  assert.equal(store.get(t.id).status, 'running');
  assert.equal(store.steer(t.id, '改成中文'), true);
  assert.equal(steered.length, 1, '應即時交給 live agent');
  assert.equal(steered[0].content[0].text, '改成中文');
  assert.deepEqual(store.view(t.id).progress.steers, ['改成中文'], '進度回饋給 UI');
  assert.equal((store.get(t.id).steerBuf || []).length, 0, '串流中不緩衝');
  gate.resolve(); await tick(); await tick();
});

test('steer：回合之間（agent 未串流）→ 緩衝,由 drainSteer 取走一次後清空', async () => {
  const gate = defer();
  let drainAt = null;
  const store = createTaskStore({
    runJob: async (spec, emit, ask, onAgent, drainSteer) => {
      onAgent({ state: { isStreaming: false }, steer: () => { throw new Error('不該走 live'); } }); // 模擬回合空檔
      await gate.promise;
      drainAt = drainSteer();           // kernel 在下一輪開頭 drain
      return { text: 'ok' };
    },
  });
  const t = store.enqueue({ mode: 'goal', goal: 'x' });
  await tick(); await tick();
  assert.equal(store.steer(t.id, '補充A'), true);
  assert.equal(store.steer(t.id, '補充B'), true);
  assert.deepEqual(store.get(t.id).steerBuf, ['補充A', '補充B'], '未串流 → 緩衝');
  gate.resolve(); await tick(); await tick();
  assert.deepEqual(drainAt, ['補充A', '補充B'], 'drainSteer 取走緩衝');
  assert.deepEqual(store.get(t.id).steerBuf, [], 'drain 後清空,不重複套用');
});

test('steer：非進行中 / 空內容 / 不存在 → false', async () => {
  const store = createTaskStore({ runJob: async () => ({}) });
  const t = store.enqueue({ mode: 'goal', goal: 'x' });
  await tick(); await tick();
  assert.equal(store.get(t.id).status, 'done');
  assert.equal(store.steer(t.id, '太遲了'), false, '已結束不可補充');
  assert.equal(store.steer('nope', 'x'), false, '不存在');

  const gate = defer();
  const s2 = createTaskStore({ runJob: async (spec, emit, ask, onAgent) => { onAgent({ state: { isStreaming: true }, steer: () => {} }); await gate.promise; return {}; } });
  const t2 = s2.enqueue({ mode: 'goal' });
  await tick(); await tick();
  assert.equal(s2.steer(t2.id, '   '), false, '空白內容不送');
  gate.resolve();
});
