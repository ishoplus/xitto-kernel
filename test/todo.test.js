// TodoWrite — 任務待辦（kernel 內建，任何 pack 都有）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTodo } from '../src/kernel/todo.js';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

test('createTodo：寫入覆蓋 + get 取回 + 過濾無效', async () => {
  const t = createTodo();
  assert.deepEqual(t.get(), []);
  await t.tool.execute('1', { todos: [{ content: '做 A', status: 'in_progress' }, { content: '做 B', status: 'pending' }, { bad: 1 }] });
  assert.equal(t.get().length, 2);
  assert.equal(t.get()[0].status, 'in_progress');
  // 覆蓋
  await t.tool.execute('2', { todos: [{ content: '做 A', status: 'completed' }] });
  assert.deepEqual(t.get(), [{ content: '做 A', status: 'completed' }]);
});

test('todo_write 註冊為唯讀（簿記，自動放行）+ kernel.todo.get', async () => {
  const k = createKernel(createCodingPack());
  assert.ok(k.registry.has('todo_write'));
  assert.ok(k.registry.readOnlyNames().includes('todo_write'));
  await k.runTool('todo_write', { todos: [{ content: 'x', status: 'pending' }] });
  assert.equal(k.todo.get().length, 1);
});
