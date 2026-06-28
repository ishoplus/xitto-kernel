// 控制與規劃：取消（abort/排隊移除）+ todo 清單進度。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStore } from '../src/app/server.js';

const tick = () => new Promise((r) => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('cancel：進行中 → abort agent → status cancelled', async () => {
  const gate = defer();
  let aborted = false;
  const store = createTaskStore({
    runJob: async (spec, emit, ask, onAgent) => {
      onAgent({ abort: () => { aborted = true; gate.resolve(); } }); // 模擬 agent
      await gate.promise;
      return { text: 'partial' };
    },
  });
  const t = store.enqueue({ mode: 'goal', goal: 'x' });
  await tick(); await tick();
  assert.equal(store.get(t.id).status, 'running');
  assert.equal(store.cancel(t.id), true);
  assert.equal(aborted, true, 'cancel 應呼叫 agent.abort()');
  await tick(); await tick();
  assert.equal(store.get(t.id).status, 'cancelled');
});

test('cancel：排隊中 → 直接移除為 cancelled（不占用執行）', async () => {
  const d1 = defer();
  const store = createTaskStore({ concurrency: 1, runJob: async (s) => { if (s.goal === 'a') await d1.promise; return {}; } });
  const a = store.enqueue({ goal: 'a' });
  const b = store.enqueue({ goal: 'b' });
  await tick();
  assert.equal(store.get(b.id).status, 'queued');
  assert.equal(store.cancel(b.id), true);
  assert.equal(store.get(b.id).status, 'cancelled');
  d1.resolve(); await tick(); await tick();
  assert.equal(store.get(a.id).status, 'done'); // a 正常完成
});

test('cancel：已結束或不存在 → false', async () => {
  const store = createTaskStore({ runJob: async () => ({}) });
  const t = store.enqueue({});
  await tick(); await tick();
  assert.equal(store.get(t.id).status, 'done');
  assert.equal(store.cancel(t.id), false);
  assert.equal(store.cancel('nope'), false);
});

test('cancel：待答中 → 解除阻塞 + abort', async () => {
  const gate = defer();
  let aborted = false;
  const store = createTaskStore({
    runJob: async (spec, emit, ask, onAgent) => {
      onAgent({ abort: () => { aborted = true; } });
      await ask({ question: '要哪個?' });   // 阻塞等回答
      gate.resolve();
      return { text: 'done-after-unblock' };
    },
  });
  const t = store.enqueue({ mode: 'goal' });
  await tick(); await tick();
  assert.equal(store.get(t.id).status, 'needs-input');
  assert.equal(store.cancel(t.id), true);
  assert.equal(aborted, true);
  await gate.promise; await tick(); await tick();
  assert.equal(store.get(t.id).status, 'cancelled');
});

test('view.continued：帶 sessionId（繼續/調整）標記為接續,否則 false', async () => {
  const store = createTaskStore({ runJob: async () => ({}) });
  const fresh = store.enqueue({ mode: 'goal', goal: 'x' });
  const follow = store.enqueue({ mode: 'goal', goal: 'y', sessionId: 's-prev' });   // 接續對話
  assert.equal(store.view(fresh.id).continued, false);
  assert.equal(store.view(follow.id).continued, true);
  await tick();
});

test('progress：todo_write → progress.todos（不算動作步,給 UI 打勾）', async () => {
  const gate = defer();
  const store = createTaskStore({
    runJob: async (spec, emit) => {
      emit({ type: 'tool', name: 'todo_write', args: { todos: [{ content: '建檔', status: 'completed' }, { content: '測試', status: 'in_progress' }] } });
      emit({ type: 'tool', name: 'write', args: { path: 'a.js' } });
      await gate.promise; return {};
    },
  });
  const t = store.enqueue({});
  await tick(); await tick();
  const p = store.view(t.id).progress;
  assert.equal(p.todos.length, 2);
  assert.equal(p.todos[1].status, 'in_progress');
  assert.equal(p.steps, 1, 'todo_write 不算動作步,只算 write 那次');
  gate.resolve();
});
