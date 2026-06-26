import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, deriveMutatingTools, isReadOnly, isMutating, isSandboxable } from '../src/kernel/tool-registry.js';

const tool = (name, meta = {}) => ({ name, label: name, description: '', parameters: {}, execute: async () => ({ content: [] }), ...meta });

const TOOLS = [
  tool('read', { readOnly: true }),
  tool('write', { mutating: true }),
  tool('bash', { mutating: true, sandboxable: true }),
  tool('grep', { readOnly: true }),
];

test('metadata 判斷子', () => {
  assert.equal(isReadOnly(tool('r', { readOnly: true })), true);
  assert.equal(isMutating(tool('w', { mutating: true })), true);
  assert.equal(isSandboxable(tool('b', { sandboxable: true })), true);
  assert.equal(isReadOnly(tool('x')), false);
});

test('deriveMutatingTools：無 pack.mutatingTools → 從 metadata 推導', () => {
  assert.deepEqual(deriveMutatingTools({}, TOOLS).sort(), ['bash', 'write']);
});

test('deriveMutatingTools：pack 顯式給 → 覆蓋 metadata', () => {
  assert.deepEqual(deriveMutatingTools({ mutatingTools: ['onlyThis'] }, TOOLS), ['onlyThis']);
});

test('registry：查詢 + 各 metadata 名單', () => {
  const r = createToolRegistry(TOOLS);
  assert.equal(r.has('bash'), true);
  assert.equal(r.get('read').name, 'read');
  assert.deepEqual(r.readOnlyNames().sort(), ['grep', 'read']);
  assert.deepEqual(r.mutatingNames().sort(), ['bash', 'write']);
  assert.deepEqual(r.sandboxableNames(), ['bash']);
  assert.deepEqual(r.names().sort(), ['bash', 'grep', 'read', 'write']);
});

test('registry：重複工具名 → 丟錯', () => {
  assert.throws(() => createToolRegistry([tool('dup'), tool('dup')]), /重複.*dup/);
});

test('registry：工具缺 name / execute → 丟錯', () => {
  assert.throws(() => createToolRegistry([{ label: 'x' }]), /name/);
  assert.throws(() => createToolRegistry([{ name: 'x' }]), /execute/);
});
