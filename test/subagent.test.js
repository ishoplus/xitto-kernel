// spawn_agent 子 agent — 註冊、唯讀、無 model 時友善失敗。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

test('spawn_agent 註冊為唯讀（守衛自動放行、不污染主狀態）', () => {
  const k = createKernel(createCodingPack());
  assert.ok(k.registry.has('spawn_agent'));
  assert.ok(k.registry.readOnlyNames().includes('spawn_agent'));
  assert.ok(![...k.mutatingTools].includes('spawn_agent'));
});

test('spawn_agent 無 model → 友善錯誤（不丟例外）', async () => {
  const k = createKernel(createCodingPack(), {}); // 無 config.model
  const r = await k.runTool('spawn_agent', { task: '查一下 X' });
  assert.ok(r.result, '應回結果而非擲錯');
  assert.match(JSON.stringify(r.result), /無 model/);
});
