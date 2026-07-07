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

// ── 擴充：go-to-definition / hover / symbols（mock server 注入）──
import { lspDefinition, lspHover, lspSymbols } from '../src/packs/shared/lsp.js';
const withCFile = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'lspx-'));
  try { writeFileSync(join(dir, 'x.c'), 'int foo(){ return 0; }\n'); return await fn(join(dir, 'x.c'), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
const MOCK_C = { c: { cmd: 'node', args: [MOCK], languageId: 'c' } };

test('lspDefinition：回 {file,line,col}（0-based→1-based）', async () => {
  await withCFile(async (f, dir) => {
    const r = await lspDefinition(f, dir, 1, 5, { timeoutMs: 4000, servers: MOCK_C });
    assert.equal(r.ok, true);
    assert.equal(r.locations.length, 1);
    assert.equal(r.locations[0].line, 10);   // mock line 9 → 10
    assert.equal(r.locations[0].col, 3);      // char 2 → 3
    assert.match(r.locations[0].file, /x\.c$/);
  });
});

test('lspHover：回 hover 文字（MarkupContent.value）', async () => {
  await withCFile(async (f, dir) => {
    const r = await lspHover(f, dir, 1, 5, { timeoutMs: 4000, servers: MOCK_C });
    assert.equal(r.ok, true);
    assert.match(r.hover, /function foo\(\): void/);
  });
});

test('lspSymbols：階層符號攤平（含 depth/kind/line）', async () => {
  await withCFile(async (f, dir) => {
    const r = await lspSymbols(f, dir, { timeoutMs: 4000, servers: MOCK_C });
    assert.equal(r.ok, true);
    assert.equal(r.symbols.length, 2);
    assert.deepEqual(r.symbols[0], { name: 'foo', kind: 'function', line: 1, col: 1, depth: 0 });
    assert.equal(r.symbols[1].name, 'bar');
    assert.equal(r.symbols[1].depth, 1);       // 子符號
  });
});

test('coding pack：4 個 LSP 工具皆註冊', () => {
  const pack = createCodingPack({ cwd: '/tmp' });
  const names = pack.tools().map((t) => t.name);
  for (const n of ['lsp_diagnostics', 'lsp_definition', 'lsp_hover', 'lsp_symbols']) assert.ok(names.includes(n), `缺 ${n}`);
});

// ── 擴充：references / rename ──
import { lspReferences, lspRename, applyTextEdits } from '../src/packs/shared/lsp.js';
const REN_SRC = 'int foo(int a) {\n    return a;\n}\nint main(void) {\n    return foo(1);\n}\n';

test('applyTextEdits：由後往前套用不位移', () => {
  const edits = [
    { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: 'bar' },
    { range: { start: { line: 4, character: 11 }, end: { line: 4, character: 14 } }, newText: 'bar' },
  ];
  const out = applyTextEdits(REN_SRC, edits);
  assert.match(out, /int bar\(int a\)/);
  assert.match(out, /return bar\(1\)/);
  assert.ok(!out.includes('foo'));
});

test('lspReferences（mock）：回引用清單（含宣告）', async () => {
  await withCFile(async (f, dir) => {
    const r = await lspReferences(f, dir, 1, 5, { timeoutMs: 4000, servers: MOCK_C });
    assert.equal(r.ok, true);
    assert.equal(r.references.length, 2);
    assert.equal(r.references[0].line, 1);
  });
});

test('lspRename（mock）→ applyTextEdits：完整重命名管線', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ren-'));
  try {
    const f = join(dir, 'm.c'); writeFileSync(f, REN_SRC);
    const r = await lspRename(f, dir, 1, 5, 'bar', { timeoutMs: 4000, servers: MOCK_C });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    const out = applyTextEdits(REN_SRC, r.changes[0].edits);
    assert.match(out, /int bar\(int a\)/);
    assert.ok(!out.includes('foo'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lsp_rename 工具：非法 newName / 不支援副檔名 → 擋下', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ren2-'));
  try {
    writeFileSync(join(dir, 'x.c'), 'int foo(){return 0;}\n');
    writeFileSync(join(dir, 'a.txt'), 'hi');
    const tool = createCodingPack({ cwd: dir }).tools().find((t) => t.name === 'lsp_rename');
    assert.ok(tool);
    const bad = JSON.parse((await tool.execute('1', { path: 'x.c', line: 1, col: 5, newName: '1bad name' })).content[0].text);
    assert.match(bad.error, /合法識別字/);
    const uns = JSON.parse((await tool.execute('2', { path: 'a.txt', line: 1, col: 1, newName: 'ok' })).content[0].text);
    assert.match(uns.error, /不支援/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coding pack：references / rename 工具已註冊', () => {
  const names = createCodingPack({ cwd: '/tmp' }).tools().map((t) => t.name);
  assert.ok(names.includes('lsp_references'));
  assert.ok(names.includes('lsp_rename'));
});

// ── 擴充：workspace/symbol（全專案符號搜尋）──
import { lspWorkspaceSymbols } from '../src/packs/shared/lsp.js';

test('lspWorkspaceSymbols（mock）：依名稱搜尋全專案符號', async () => {
  await withCFile(async (f, dir) => {
    const r = await lspWorkspaceSymbols(f, dir, 'add', { timeoutMs: 4000, servers: MOCK_C });
    assert.equal(r.ok, true);
    assert.equal(r.symbols.length, 2);
    assert.equal(r.symbols[0].name, 'add');
    assert.equal(r.symbols[0].kind, 'function');
    assert.equal(r.symbols[0].line, 10);   // range line 9 → 1-based 10
    assert.match(r.symbols[0].file, /lib\.c$/);
  });
});

test('coding pack：lsp_workspace_symbols 工具已註冊', () => {
  assert.ok(createCodingPack({ cwd: '/tmp' }).tools().map((t) => t.name).includes('lsp_workspace_symbols'));
});
