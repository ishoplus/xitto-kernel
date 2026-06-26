// PreToolUse / PostToolUse hooks。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHooks, runPreToolHooks, runPostToolHooks } from '../src/kernel/hooks.js';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

test('loadHooks：解析 settings.json；無檔回空', () => {
  assert.deepEqual(loadHooks('/no/such/file.json'), { PreToolUse: [], PostToolUse: [] });
});

test('runPreToolHooks：matched 失敗→block；passed/未matched→放行', () => {
  const hooks = { PreToolUse: [{ matcher: 'write', command: 'exit 1' }], PostToolUse: [] };
  const blocked = runPreToolHooks(hooks, 'write', process.cwd());
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /PreToolUse/);
  assert.equal(runPreToolHooks(hooks, 'read', process.cwd()), undefined); // 未 match
  assert.equal(runPreToolHooks({ PreToolUse: [{ matcher: 'write', command: 'true' }] }, 'write', process.cwd()), undefined); // 成功
});

test('runPostToolHooks：matched 失敗回清單', () => {
  const fails = runPostToolHooks({ PostToolUse: [{ matcher: 'edit', command: 'exit 3' }] }, 'edit', process.cwd());
  assert.equal(fails.length, 1);
  assert.equal(fails[0].command, 'exit 3');
});

test('整合：settings.json 的 PreToolUse 擋下 write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
  try {
    const sdir = join(dir, '.xitto-kernel', 'coding');
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'write|edit', command: 'exit 1' }] } }));
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    const r = await k.runTool('write', { path: 'a.txt', content: 'x' });
    assert.equal(r.blocked, true);
    assert.match(r.reason, /PreToolUse/);
    // read 未 match → 不受影響
    writeFileSync(join(dir, 'b.txt'), 'hi');
    assert.ok((await k.runTool('read', { path: 'b.txt' })).result);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
