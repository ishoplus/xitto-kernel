// LSP client（移植 CC 語言伺服器診斷）— 線協議純函式 + mock server 端到端 + 高階/工具優雅退場。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMessage, createDecoder, createLspClient, lspDiagnostics, serverFor, hasCommand } from '../src/packs/shared/lsp.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const MOCK = fileURLToPath(new URL('./fixtures/mock-lsp.mjs', import.meta.url));

test('encodeMessage：正確 Content-Length 框架', () => {
  const s = encodeMessage({ a: 1 });
  const body = '{"a":1}';
  assert.equal(s, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
});

test('createDecoder：拆分/多訊息/半截皆正確重組', () => {
  const dec = createDecoder();
  assert.deepEqual(dec.push(encodeMessage({ id: 1 })), [{ id: 1 }]);
  // 一次餵兩則
  assert.deepEqual(dec.push(encodeMessage({ id: 2 }) + encodeMessage({ id: 3 })), [{ id: 2 }, { id: 3 }]);
  // 半截：先給前半 → 無輸出；補後半 → 湊齊
  const full = encodeMessage({ id: 4 });
  const cut = Math.floor(full.length / 2);
  assert.deepEqual(dec.push(full.slice(0, cut)), []);
  assert.deepEqual(dec.push(full.slice(cut)), [{ id: 4 }]);
});

test('client 端到端（mock server）：initialize → didOpen → 收 publishDiagnostics', async () => {
  const client = createLspClient({ cmd: 'node', args: [MOCK], cwd: process.cwd() });
  try {
    await client.initialize('file:///tmp');
    const uri = 'file:///tmp/a.c';
    client.didOpen(uri, 'c', 'int main(){}');
    const ds = await client.waitDiagnostics(uri, 4000);
    assert.equal(ds.length, 2);
    assert.equal(ds[0].message, 'mock: undefined symbol');
    assert.equal(ds[0].severity, 1);
  } finally { client.shutdown(); }
});

test('lspDiagnostics 高階（mock server 注入）：診斷映射成 {line,col,severity,message}', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsp-'));
  try {
    const cfile = join(dir, 'x.c');
    writeFileSync(cfile, 'int main(){ return x; }\n');
    const r = await lspDiagnostics(cfile, dir, {
      timeoutMs: 4000,
      servers: { c: { cmd: 'node', args: [MOCK], languageId: 'c' } },
    });
    assert.equal(r.ok, true);
    assert.equal(r.diagnostics.length, 2);
    assert.equal(r.diagnostics[0].line, 3);       // mock line 2 → 1-based 3
    assert.equal(r.diagnostics[0].col, 6);        // char 5 → 1-based 6
    assert.equal(r.diagnostics[0].severity, 'error');
    assert.equal(r.diagnostics[1].severity, 'warning');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lspDiagnostics：server 未安裝 → 優雅回報（不丟例外）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsp2-'));
  try {
    writeFileSync(join(dir, 'a.py'), 'x = 1\n');
    const r = await lspDiagnostics(join(dir, 'a.py'), dir, { servers: { py: { cmd: 'definitely-not-a-real-lsp-xyz', args: [], languageId: 'python' } } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /未安裝/);
    assert.equal(r.install, 'definitely-not-a-real-lsp-xyz');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serverFor：副檔名 → server 白名單；不支援回 null', () => {
  assert.equal(serverFor('a.ts').cmd, 'typescript-language-server');
  assert.equal(serverFor('a.py').cmd, 'pyright-langserver');
  assert.equal(serverFor('a.cpp').cmd, 'clangd');
  assert.equal(serverFor('a.txt'), null);
});

test('coding pack lsp_diagnostics 工具：不支援副檔名 / server 未裝 → 友善訊息', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsp3-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'hi');
    writeFileSync(join(dir, 'a.py'), 'x=1');
    const pack = createCodingPack({ cwd: dir });
    const tool = pack.tools().find((t) => t.name === 'lsp_diagnostics');
    assert.ok(tool, '應有 lsp_diagnostics 工具');
    const unsupported = JSON.parse((await tool.execute('1', { path: 'a.txt' })).content[0].text);
    assert.match(unsupported.error, /不支援/);
    // pyright 幾乎不會裝在 CI → 應回 ok:false + hint（若剛好裝了則 ok:true 亦可接受）
    const py = JSON.parse((await tool.execute('2', { path: 'a.py' })).content[0].text);
    if (!hasCommand('pyright-langserver')) { assert.equal(py.ok, false); assert.match(py.reason, /未安裝/); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
