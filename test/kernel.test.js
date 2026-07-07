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
  assert.deepEqual([...k.mutatingTools].sort(), ['bash', 'bash_bg', 'edit', 'git_commit', 'lsp_rename', 'skill_run', 'write']);
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

test('data-query pack：同一個 kernel、零改動、不同領域（真實 sqlite）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-'));
  try {
    const k = createKernel(createDataQueryPack({ cwd: dir }), { cwd: dir });
    // 只有 sql_exec 是 mutating（sql_query 唯讀）→ 證明 metadata 推導跨領域通用
    assert.deepEqual([...k.mutatingTools], ['sql_exec', 'skill_run']);

    // schema-before-query：未看 schema 先查 → 擋（對照 read-before-edit，同插槽不同領域）
    const blocked = await k.runTool('sql_query', { sql: 'SELECT 1' });
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason, /list_tables|describe_table/);

    // 看 schema 後放行；真實 sqlite：建表→寫入→查回
    await k.runTool('list_tables', {});
    await k.runTool('sql_exec', { sql: "CREATE TABLE t(id,name); INSERT INTO t VALUES(1,'amy'),(2,'bob');" });
    const q = await k.runTool('sql_query', { sql: 'SELECT count(*) AS n FROM t' });
    assert.match(q.result.content[0].text, /\b2\b/); // 真的查到 2 筆

    // sql_query 擋寫入型 SQL
    const w = await k.runTool('sql_query', { sql: 'DELETE FROM t' });
    assert.match(w.result.content[0].text, /sql_exec/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

// 環境能力門控：不同環境（雲端/本機）只暴露該環境能用的工具/技能，並把邊界寫進 system prompt。
test('環境門控：caps/env 不滿足的 pack 工具不註冊，滿足的照常在', () => {
  const pack = {
    name: 'envpack', systemPrompt: 'x', tools: () => [
      { name: 'read_ws', readOnly: true, requires: ['workspaceFs'], description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) },
      { name: 'browse_host', readOnly: true, requires: ['hostFs'], description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) },
      { name: 'local_only', readOnly: true, env: 'local', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) },
    ],
  };
  // 雲端：有 workspaceFs、無 hostFs → read_ws 在、browse_host / local_only 被剔除
  const cloud = createKernel(pack, { caps: ['workspaceFs', 'shell'], env: 'cloud' });
  assert.ok(cloud.registry.has('read_ws'), '雲端應保留 workspace 工具（agent 可查看分配目錄）');
  assert.ok(!cloud.registry.has('browse_host'), '雲端缺 hostFs → 主機瀏覽工具不註冊');
  assert.ok(!cloud.registry.has('local_only'), 'env:local 工具在雲端不註冊');
  assert.deepEqual(cloud.env.droppedTools.sort(), ['browse_host', 'local_only']);
  // 本機：全能力 → 三個都在
  const localK = createKernel(pack, { caps: ['workspaceFs', 'hostFs', 'shell'], env: 'local' });
  for (const n of ['read_ws', 'browse_host', 'local_only']) assert.ok(localK.registry.has(n));
  // 未給 caps（CLI）→ 不門控，向後相容
  const cli = createKernel(pack);
  for (const n of ['read_ws', 'browse_host', 'local_only']) assert.ok(cli.registry.has(n));
});

test('環境門控：envNote 注入 system prompt', () => {
  const pack = { name: 'envpack2', systemPrompt: 'base', tools: () => [] };
  const k = createKernel(pack, { caps: ['workspaceFs'], env: 'cloud', envNote: '你運行在雲端託管容器。' });
  assert.match(k.systemPrompt, /運行環境/);
  assert.match(k.systemPrompt, /雲端託管容器/);
});
