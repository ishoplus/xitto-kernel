// 進度可見性：mapEvent 新事件（round/verify）+ 任務 progress 累積（給 UI「正在做什麼」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStore, mapEvent } from '../src/app/server.js';

const tick = () => new Promise((r) => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('mapEvent：round / verify 事件 → 進度事件', () => {
  assert.deepEqual(mapEvent({ type: 'round', round: 2, maxRounds: 12 }), { type: 'round', round: 2, maxRounds: 12 });
  assert.deepEqual(mapEvent({ type: 'verify_start' }), { type: 'phase', phase: 'verifying' });
  assert.deepEqual(mapEvent({ type: 'verify_end', ok: true }), { type: 'phase', phase: 'verified' });
  assert.deepEqual(mapEvent({ type: 'verify_end', ok: false }), { type: 'phase', phase: 'fixing' });
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
