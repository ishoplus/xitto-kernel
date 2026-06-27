// 漸進式放權：allow-store 持久化 + permission-step 用已信任自動放行（跨「session」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAllowStore, fileAllowStore } from '../src/kernel/security/allow-store.js';
import { createPermissionStep } from '../src/kernel/security/permission-step.js';

const registry = { get: (n) => ({ bash: { name: 'bash', sandboxable: true }, write: { name: 'write', mutating: true }, read: { name: 'read', readOnly: true } }[n]) };

test('memoryAllowStore：add/has/remove/clear', () => {
  const s = memoryAllowStore();
  assert.equal(s.hasTool('write'), false);
  s.addTool('write'); assert.equal(s.hasTool('write'), true);
  s.addSig('git status'); assert.equal(s.hasSig('git status'), true);
  assert.deepEqual(s.list(), { tools: ['write'], bash: ['git status'] });
  assert.equal(s.remove('git status'), true);
  assert.equal(s.hasSig('git status'), false);
  s.clear(); assert.equal(s.size(), 0);
});

test('fileAllowStore：落地後重新載入仍記得（跨 session）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xk-allow-'));
  const path = join(dir, 'allow.json');
  try {
    const s1 = fileAllowStore(path);
    s1.addTool('write');
    s1.addSig('npm test');
    assert.ok(existsSync(path), '應已落地');
    assert.match(readFileSync(path, 'utf8'), /npm test/);
    // 模擬重啟：新 store 從同檔載入
    const s2 = fileAllowStore(path);
    assert.equal(s2.hasTool('write'), true);
    assert.equal(s2.hasSig('npm test'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('permission-step：選 always 寫入 store,下次同工具自動放行', async () => {
  const store = memoryAllowStore();
  let asks = 0;
  const confirm = async () => { asks++; return 'always'; };
  const step = createPermissionStep({ registry, confirm, store });
  assert.equal(await step({ name: 'write', args: { path: 'a' } }), undefined); // 問一次→記住
  assert.equal(await step({ name: 'write', args: { path: 'b' } }), undefined); // 不再問
  assert.equal(asks, 1, '第二次應走信任、不再 confirm');
  assert.equal(store.hasTool('write'), true);
});

test('permission-step：選 command 只信任該簽章類,其他命令仍要問', async () => {
  const store = memoryAllowStore();
  const seen = [];
  const confirm = async (name, args, danger, meta) => { seen.push(meta.signature); return 'command'; };
  const step = createPermissionStep({ registry, confirm, store });
  await step({ name: 'bash', args: { command: 'git status' } });          // 信任 git status
  assert.equal(store.hasSig('git status'), true);
  assert.equal(await step({ name: 'bash', args: { command: 'git status -s' } }), undefined); // 同簽章→免問
  await step({ name: 'bash', args: { command: 'rm foo' } });              // 不同簽章→再問
  assert.deepEqual(seen, ['git status', 'rm']);
});

test('permission-step：onTrusted 在自動放行時通知', async () => {
  const store = memoryAllowStore({ tools: ['write'] });
  const notes = [];
  const step = createPermissionStep({ registry, confirm: async () => 'no', store, onTrusted: (i) => notes.push(i) });
  await step({ name: 'write', args: { path: 'x' } });
  assert.deepEqual(notes, [{ name: 'write', signature: null, scope: 'tool' }]);
});

test('permission-step：危險命令即使選 always 也不寫入信任', async () => {
  const store = memoryAllowStore();
  const dangerReg = { get: () => ({ name: 'bash', sandboxable: true }) };
  const step = createPermissionStep({ registry: dangerReg, confirm: async () => 'always', store });
  const d = await step({ name: 'bash', args: { command: 'rm -rf /' } });
  assert.ok(d && d.block, '危險命令選 always 應只放行這次（這裡 confirm 回 always 但危險→不寫信任、且因非 yes→擋）');
  assert.equal(store.size(), 0, '危險命令不得進信任清單');
});
