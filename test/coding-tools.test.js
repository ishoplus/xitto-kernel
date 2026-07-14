// coding pack 工具升級：grep / glob / read(行號,offset) / edit(唯一性,replaceAll)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctools-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.js'), 'export const X = 1;\nfunction foo() { return X; }\n');
  writeFileSync(join(dir, 'src', 'b.ts'), 'const y = 2;\n// foo here\n');
  writeFileSync(join(dir, 'readme.md'), '# Title\nfoo bar\n');
  const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
  return { dir, k };
};

test('工具齊（含 grep/glob/web_search/web_fetch）', () => {
  const { dir, k } = setup();
  try { for (const n of ['read', 'ls', 'glob', 'grep', 'write', 'edit', 'bash', 'web_search', 'web_fetch']) assert.ok(k.registry.has(n), n); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('glob：** 遞迴 + 副檔名過濾', async () => {
  const { dir, k } = setup();
  try {
    const r = await k.runTool('glob', { pattern: 'src/**/*.js' });
    const o = JSON.parse(r.result.content[0].text);
    assert.deepEqual(o.files, ['src/a.js']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grep：正則搜內容、回 path:line、glob 過濾', async () => {
  const { dir, k } = setup();
  try {
    const all = await k.runTool('grep', { pattern: 'foo' });
    const t = all.result.content[0].text;
    assert.match(t, /src\/a\.js:2:/);
    assert.match(t, /readme\.md:2:/);
    // glob 限定只搜 .js
    const js = await k.runTool('grep', { pattern: 'foo', glob: '*.js' });
    assert.match(js.result.content[0].text, /a\.js/);
    assert.doesNotMatch(js.result.content[0].text, /readme/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grep：context 顯示上下文行', async () => {
  const { dir, k } = setup();
  try {
    const r = await k.runTool('grep', { pattern: 'function foo', glob: '*.js', context: 1 });
    const t = r.result.content[0].text;
    // 命中行內容 + 因 context 才出現的前一行內容（斷言內容本身，兼容 rg 的 - 分隔與 JS 回退的 : 分隔）
    assert.match(t, /function foo/);      // 命中行
    assert.match(t, /export const X/);    // 前一行：只有開了 context 才會出現
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grep：outputMode files_with_matches / count', async () => {
  const { dir, k } = setup();
  try {
    const fwm = await k.runTool('grep', { pattern: 'foo', outputMode: 'files_with_matches' });
    const lines = fwm.result.content[0].text.split('\n');
    assert.ok(lines.includes('src/a.js'), '只列檔名');
    assert.ok(!/:\d+:/.test(fwm.result.content[0].text), '不含行號/內容');
    const cnt = await k.runTool('grep', { pattern: 'foo', glob: '*.js', outputMode: 'count' });
    assert.match(cnt.result.content[0].text, /src\/a\.js:1/); // a.js 有 1 行含 foo
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('edit：edits 陣列一次改多處，任一筆失敗整批不改（原子）', async () => {
  const { dir, k } = setup();
  try {
    const f = join(dir, 'multi.txt');
    writeFileSync(f, 'alpha\nbeta\ngamma\n');
    await k.runTool('read', { path: 'multi.txt' });
    // 成功：兩處替換
    const ok = await k.runTool('edit', { path: 'multi.txt', edits: [{ oldText: 'alpha', newText: 'A' }, { oldText: 'gamma', newText: 'G' }] });
    assert.match(ok.result.content[0].text, /"edits":2/);
    assert.equal(readFileSync(f, 'utf8'), 'A\nbeta\nG\n');
    // 失敗：第二筆找不到 → 整批回退，檔案不變
    const bad = await k.runTool('edit', { path: 'multi.txt', edits: [{ oldText: 'A', newText: 'x' }, { oldText: '不存在', newText: 'y' }] });
    assert.match(bad.result.content[0].text, /failedAt/);
    assert.equal(readFileSync(f, 'utf8'), 'A\nbeta\nG\n', '整批未套用');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read：附行號 + offset/limit', async () => {
  const { dir, k } = setup();
  try {
    const r = await k.runTool('read', { path: 'src/a.js' });
    assert.match(r.result.content[0].text, /^\s+1\texport const X/);
    const seg = await k.runTool('read', { path: 'src/a.js', offset: 2, limit: 1 });
    assert.match(seg.result.content[0].text, /^\s+2\tfunction foo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('edit：oldText 多次出現且未 replaceAll → 擋；replaceAll 全換', async () => {
  const { dir, k } = setup();
  try {
    const f = join(dir, 'dup.txt');
    writeFileSync(f, 'a a a');
    await k.runTool('read', { path: 'dup.txt' });
    const blocked = await k.runTool('edit', { path: 'dup.txt', oldText: 'a', newText: 'b' });
    assert.match(blocked.result.content[0].text, /出現 3 次/);
    assert.equal(readFileSync(f, 'utf8'), 'a a a', '未 replaceAll 不該改');
    const ok = await k.runTool('edit', { path: 'dup.txt', oldText: 'a', newText: 'b', replaceAll: true });
    assert.match(ok.result.content[0].text, /"replaced":3/);
    assert.equal(readFileSync(f, 'utf8'), 'b b b');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
