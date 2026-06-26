// 互動權限確認：confirm 回呼 + always 記憶 + 危險命令不因 always 永久放行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

test('confirm=no → mutating 工具被擋', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, confirm: async () => 'no' });
    const r = await k.runTool('write', { path: 'a.txt', content: 'x' });
    assert.equal(r.blocked, true);
    assert.match(r.reason, /拒絕/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('always → 同工具後續自動放行（confirm 只問一次）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm2-'));
  try {
    let calls = 0;
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, confirm: async () => { calls++; return 'always'; } });
    await k.runTool('write', { path: 'a.txt', content: 'x' });
    await k.runTool('write', { path: 'b.txt', content: 'y' });
    await k.runTool('write', { path: 'c.txt', content: 'z' });
    assert.equal(calls, 1, 'always 後同工具不應再問');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('危險命令：always 也只放行一次（每次都重新把關）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm3-'));
  try {
    let calls = 0;
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, confirm: async () => { calls++; return 'always'; } });
    // 用 guardToolCall 只取決策、不實際執行 rm
    await k.guardToolCall({ name: 'bash', args: { command: 'rm -rf /tmp/x1' } });
    await k.guardToolCall({ name: 'bash', args: { command: 'rm -rf /tmp/x2' } });
    assert.equal(calls, 2, '危險命令每次都要重新確認，不因 always 永久放行');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('唯讀工具不觸發 confirm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm4-'));
  try {
    let calls = 0;
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, confirm: async () => { calls++; return 'no'; } });
    await k.runTool('ls', { path: '.' });
    await k.runTool('memory_list', {});
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
