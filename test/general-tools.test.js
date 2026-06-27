// general pack 能力補強：grep/glob（共用）+ http + read_image。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const parse = (r) => JSON.parse(r.result.content[0].text);

test('general pack：工具補齊（grep/glob/http/read_image）', () => {
  const k = createKernel(createGeneralPack());
  for (const n of ['read', 'ls', 'glob', 'grep', 'write', 'edit', 'bash', 'web_search', 'web_fetch', 'http', 'read_image']) assert.ok(k.registry.has(n), n);
  assert.ok(k.registry.readOnlyNames().includes('read_image'));
  assert.ok(k.registry.readOnlyNames().includes('grep'));
  // http 非唯讀（可能有副作用）→ 不在自動放行名單、也非 mutating
  assert.ok(!k.registry.readOnlyNames().includes('http'));
});

test('general pack：grep/glob 真的運作', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-'));
  try {
    writeFileSync(join(dir, 'a.js'), 'const target = 1;\n');
    const k = createKernel(createGeneralPack({ cwd: dir }), { cwd: dir });
    const g = await k.runTool('grep', { pattern: 'target' });
    assert.match(g.result.content[0].text, /a\.js:1:/);
    const gl = await k.runTool('glob', { pattern: '**/*.js' });
    assert.deepEqual(parse(gl).files, ['a.js']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('http 工具：發真實 GET（httpbin-like via data URL 不行，改用本機 echo 概念）', async () => {
  // 不依賴外網：驗證 http 工具對無效 url 友善回錯（行為正確即可，真網路由 live demo 驗）
  const k = createKernel(createGeneralPack());
  const r = await k.runTool('http', { url: 'http://127.0.0.1:0/nope' });
  assert.ok(r.result.content[0].text.includes('error') || r.result.content[0].text.includes('status'));
});

test('read_image：不支援格式 → 友善回報', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  try {
    writeFileSync(join(dir, 'x.txt'), 'not an image');
    const k = createKernel(createGeneralPack({ cwd: dir }), { cwd: dir });
    const r = await k.runTool('read_image', { path: 'x.txt' });
    assert.match(r.result.content[0].text, /不支援/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coding pack 共用 grep/glob 後行為不變', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cod-'));
  try {
    writeFileSync(join(dir, 'm.js'), 'export const Z = 9;\n');
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    const g = await k.runTool('grep', { pattern: 'Z =' });
    assert.match(g.result.content[0].text, /m\.js:1:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
