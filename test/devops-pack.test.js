// devops pack 註冊 + 工具（全由共用模組組成）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKernel } from '../src/kernel/index.js';
import { createDevopsPack } from '../src/packs/devops/index.js';

test('devops pack：工具齊（fs + grep/glob + bash_bg + http）', () => {
  const k = createKernel(createDevopsPack());
  for (const n of ['read', 'ls', 'glob', 'grep', 'write', 'edit', 'bash', 'bash_bg', 'bash_output', 'bash_kill', 'http']) assert.ok(k.registry.has(n), n);
  assert.ok([...k.mutatingTools].sort().includes('bash'));
  assert.ok([...k.mutatingTools].sort().includes('bash_bg'));
});

test('devops pack：read-before-edit 守衛（共用 fs-tools）', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dv-'));
  try {
    writeFileSync(join(dir, 'c.conf'), 'x=1\n');
    const k = createKernel(createDevopsPack({ cwd: dir }), { cwd: dir });
    const blocked = await k.runTool('edit', { path: 'c.conf', oldText: 'x=1', newText: 'x=2' });
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason, /read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
