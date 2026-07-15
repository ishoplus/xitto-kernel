// deep-research pack 註冊 + 工具 + 共用 web 工具。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKernel } from '../src/kernel/index.js';
import { createDeepResearchPack } from '../src/packs/deep-research/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

test('deep-research pack：註冊 + 工具（web_search/web_fetch/write/read）', () => {
  const k = createKernel(createDeepResearchPack());
  for (const n of ['web_search', 'web_fetch', 'write', 'read']) assert.ok(k.registry.has(n), n);
  assert.ok(k.registry.readOnlyNames().includes('web_search'));
  assert.ok(k.registry.readOnlyNames().includes('web_fetch'));
  assert.deepEqual([...k.mutatingTools], ['write', 'skill_run', 'marketplace_add']);
});

test('general pack 改用共用 web 工具後仍齊', () => {
  const k = createKernel(createGeneralPack());
  for (const n of ['web_search', 'web_fetch', 'http']) assert.ok(k.registry.has(n), n);
});
