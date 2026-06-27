// kernel 組裝整合測試 — 證明同一個 kernel 跑兩個領域、守衛真實生效、kernel 零領域知識。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';
import { createDataQueryPack } from '../src/packs/data-query/index.js';

test('coding pack：mutatingTools 從工具 metadata 推導', () => {
  const k = createKernel(createCodingPack());
  assert.deepEqual([...k.mutatingTools].sort(), ['bash', 'bash_bg', 'edit', 'git_commit', 'write']);
  // pack 的唯讀工具（kernel 另注入 memory_save/memory_list，故用 subset 檢查）
  for (const n of ['ls', 'read']) assert.ok(k.registry.readOnlyNames().includes(n));
  // kernel 內建記憶工具：任何 pack 都有
  assert.ok(k.registry.has('memory_save') && k.registry.has('memory_list'));
});

test('coding pack：read-before-edit 真實生效（守衛 + 工具共享狀態）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k-coding-'));
  try {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello world');
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });

    // 未先 read 就 edit → 被 read-before-edit 擋
    const blocked = await k.runTool('edit', { path: 'a.txt', oldText: 'hello', newText: 'hi' });
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason, /read-before-edit/);
    assert.equal(readFileSync(file, 'utf8'), 'hello world', '被擋時不該改檔');

    // 先 read，再 edit → 放行且真的改檔
    await k.runTool('read', { path: 'a.txt' });
    const ok = await k.runTool('edit', { path: 'a.txt', oldText: 'hello', newText: 'hi' });
    assert.ok(ok.result, '應執行成功');
    assert.equal(readFileSync(file, 'utf8'), 'hi world');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('data-query pack：同一個 kernel、零改動、不同領域', async () => {
  const k = createKernel(createDataQueryPack());
  // 只有 sql_exec 是 mutating（sql_query 唯讀）→ 證明 metadata 推導跨領域通用
  assert.deepEqual([...k.mutatingTools], ['sql_exec']);

  // schema-before-query：未看 schema 先查 → 擋（對照 read-before-edit，同插槽不同領域）
  const blocked = await k.runTool('sql_query', { sql: 'SELECT 1' });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /list_tables|describe_table/);

  // 先看 schema → 放行
  await k.runTool('list_tables', {});
  const ok = await k.runTool('sql_query', { sql: 'SELECT 1' });
  assert.ok(ok.result);
});

test('plan 模式擋 mutating 工具、放行唯讀', async () => {
  let plan = true;
  const dir = mkdtempSync(join(tmpdir(), 'k-plan-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, getPlanMode: () => plan });
    const w = await k.runTool('write', { path: 'x.txt', content: 'y' });
    assert.equal(w.blocked, true);
    assert.match(w.reason, /計劃模式/);
    const ls = await k.runTool('ls', { path: '.' });   // 唯讀仍放行
    assert.ok(ls.result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未知工具 → permission 擋下', async () => {
  const k = createKernel(createCodingPack());
  const r = await k.guardToolCall({ name: 'nope', args: {} });
  assert.equal(r.block, true);
  assert.match(r.reason, /未知工具/);
});

test('confirm 注入：mutating 工具拒絕則擋', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k-confirm-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, confirm: async () => 'no' });
    const r = await k.runTool('write', { path: 'x.txt', content: 'y' });
    assert.equal(r.blocked, true);
    assert.match(r.reason, /拒絕/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
