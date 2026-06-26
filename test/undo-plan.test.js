// /undo 快照還原 + 計劃模式擋 mutating。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

test('undo：還原被覆寫的檔', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'undo-'));
  try {
    const f = join(dir, 'a.txt');
    writeFileSync(f, '原內容');
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    await k.runTool('read', { path: 'a.txt' });                  // 過 read-before-edit
    await k.runTool('edit', { path: 'a.txt', oldText: '原內容', newText: '新內容' });
    assert.equal(readFileSync(f, 'utf8'), '新內容');
    const r = k.undo();
    assert.equal(r.undone, true);
    assert.equal(readFileSync(f, 'utf8'), '原內容', 'undo 應還原原內容');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('undo：新建的檔 → 刪除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'undo2-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    await k.runTool('write', { path: 'new.txt', content: 'hi' });
    assert.ok(existsSync(join(dir, 'new.txt')));
    const r = k.undo();
    assert.equal(r.undone, true);
    assert.equal(r.created, true);
    assert.equal(existsSync(join(dir, 'new.txt')), false, 'undo 應刪除新建檔');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('undo：無改動 → 回 undone:false', () => {
  const k = createKernel(createCodingPack(), {});
  assert.equal(k.undo().undone, false);
});

test('計劃模式：擋 mutating、放行唯讀', async () => {
  let plan = true;
  const dir = mkdtempSync(join(tmpdir(), 'plan-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, getPlanMode: () => plan });
    const w = await k.runTool('write', { path: 'x.txt', content: 'y' });
    assert.equal(w.blocked, true);
    assert.match(w.reason, /計劃模式/);
    assert.ok((await k.runTool('ls', { path: '.' })).result);   // 唯讀放行
    plan = false;
    assert.ok((await k.runTool('write', { path: 'x.txt', content: 'y' })).result); // 關閉後可寫
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
