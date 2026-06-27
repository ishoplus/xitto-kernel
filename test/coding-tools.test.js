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

test('工具齊（含 grep/glob/web_fetch）', () => {
  const { dir, k } = setup();
  try { for (const n of ['read', 'ls', 'glob', 'grep', 'write', 'edit', 'bash', 'web_fetch']) assert.ok(k.registry.has(n), n); }
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
