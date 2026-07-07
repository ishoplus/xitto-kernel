// 極簡 LSP client — 移植 Claude Code 的語言伺服器智能（診斷）。給 agent 真正的程式碼
// 理解：跑對應語言的 language server，取 textDocument/publishDiagnostics（型別錯、未定義、
// 未使用…），而非只靠 grep。零第三方依賴，只用 node child_process。
//
// 分三層：① 線協議編解碼（純函式，可單元測試）② client（JSON-RPC over stdio + 生命週期）
// ③ 高階 lspDiagnostics（偵測語言→找 server→initialize→didOpen→收診斷）。
// server 命令來自固定白名單（依副檔名），非使用者提供的任意命令——不成為任意執行的破口。
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// ── ① 線協議：Content-Length 框架 ──
export function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

// 有狀態解碼器：餵入 chunk（Buffer/字串），回傳這次湊齊的完整訊息陣列。
export function createDecoder() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const out = [];
      for (;;) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = buf.slice(0, headerEnd).toString('utf8');
        const m = header.match(/content-length:\s*(\d+)/i);
        if (!m) { buf = buf.slice(headerEnd + 4); continue; }
        const len = parseInt(m[1], 10);
        const start = headerEnd + 4;
        if (buf.length < start + len) break;           // body 還沒到齊
        const body = buf.slice(start, start + len).toString('utf8');
        buf = buf.slice(start + len);
        try { out.push(JSON.parse(body)); } catch { /* 壞訊息略過 */ }
      }
      return out;
    },
  };
}

// ── ② client：spawn server + JSON-RPC 相關 ──
export function createLspClient({ cmd, args = [], cwd }) {
  const proc = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  if (proc.unref) proc.unref(); // 子行程不擋父行程退場（shutdown 仍會明確 kill；避免測試/短命流程被懸置）
  const decoder = createDecoder();
  const pending = new Map();      // id → {resolve,reject}
  const diagnostics = new Map();  // uri → diagnostics[]
  const diagWaiters = new Map();  // uri → [resolve]
  let seq = 0, alive = true, spawnErr = null;

  const send = (obj) => { if (alive) { try { proc.stdin.write(encodeMessage(obj)); } catch { /* 已關 */ } } };
  const handle = (msg) => {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message || 'LSP error')) : p.resolve(msg.result); }
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = msg.params?.uri; const ds = msg.params?.diagnostics || [];
      if (uri) {
        diagnostics.set(uri, ds);
        const ws = diagWaiters.get(uri); if (ws) { diagWaiters.delete(uri); ws.forEach((r) => r(ds)); }
      }
    } else if (msg.id !== undefined && msg.method) {
      send({ jsonrpc: '2.0', id: msg.id, result: null }); // server→client 請求（如 workspace/configuration）：回 null 讓它繼續
    }
  };
  proc.stdout.on('data', (chunk) => { for (const m of decoder.push(chunk)) handle(m); });
  proc.stderr.on('data', () => {});
  proc.on('error', (e) => { alive = false; spawnErr = e; for (const p of pending.values()) p.reject(e); pending.clear(); });
  proc.on('exit', () => { alive = false; for (const p of pending.values()) p.reject(new Error('LSP server exited')); pending.clear(); });

  const request = (method, params) => new Promise((resolve, reject) => {
    if (!alive) return reject(spawnErr || new Error('LSP server not running'));
    const id = ++seq; pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

  return {
    get alive() { return alive; },
    request, notify,
    async initialize(rootUri) {
      await request('initialize', { processId: process.pid, rootUri: rootUri || null, capabilities: { textDocument: { publishDiagnostics: {} } }, workspaceFolders: null });
      notify('initialized', {});
    },
    didOpen(uri, languageId, text) { notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } }); },
    waitDiagnostics(uri, timeoutMs = 8000) {
      return new Promise((resolve) => {
        if (diagnostics.has(uri)) return resolve(diagnostics.get(uri));
        let done = false;
        // 收到診斷或逾時都走 finish；清掉 timer，避免懸置計時器拖住事件迴圈（測試不退場）
        const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
        const arr = diagWaiters.get(uri) || []; arr.push(finish); diagWaiters.set(uri, arr);
        const t = setTimeout(() => finish(diagnostics.get(uri) || []), timeoutMs);
        if (t.unref) t.unref();
      });
    },
    shutdown() {
      try { notify('exit'); } catch { /* 略 */ }
      try { proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); } catch { /* 略 */ }
      try { proc.kill('SIGKILL'); } catch { /* 略 */ }
    },
  };
}

// ── ③ 高階：依副檔名選 server → 取診斷 ──
// server 命令白名單（依語言）。args 皆為 --stdio 型。
export const LSP_SERVERS = {
  ts: { cmd: 'typescript-language-server', args: ['--stdio'], languageId: 'typescript' },
  js: { cmd: 'typescript-language-server', args: ['--stdio'], languageId: 'javascript' },
  py: { cmd: 'pyright-langserver', args: ['--stdio'], languageId: 'python' },
  go: { cmd: 'gopls', args: [], languageId: 'go' },
  rs: { cmd: 'rust-analyzer', args: [], languageId: 'rust' },
  c: { cmd: 'clangd', args: [], languageId: 'c' },
  cpp: { cmd: 'clangd', args: [], languageId: 'cpp' },
};
const EXT_LANG = { ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', py: 'py', pyi: 'py', go: 'go', rs: 'rs', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp' };

export function serverFor(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const lang = m ? EXT_LANG[m[1]] : null;
  return lang ? { lang, ...LSP_SERVERS[lang] } : null;
}
export function hasCommand(cmd) {
  try { return spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0; } catch { return false; }
}
const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
const SYMBOL_KIND = { 1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 15: 'string', 16: 'number', 17: 'boolean', 18: 'array', 19: 'object', 20: 'key', 21: 'null', 22: 'enum-member', 23: 'struct', 24: 'event', 25: 'operator', 26: 'type-parameter' };

// 開一個 LSP session（spawn server + initialize + didOpen）。回 { ok, client, uri, cfg } 或
// { ok:false, reason }（server 未安裝/讀檔失敗/啟動失敗，皆優雅回報不丟例外）。用完務必 client.shutdown()。
async function openSession(absPath, cwd, { servers = LSP_SERVERS } = {}) {
  const s = serverFor(absPath);
  if (!s || !s.cmd) return { ok: false, reason: `不支援此副檔名的 LSP（${absPath}）` };
  const cfg = servers[s.lang] || s;
  if (!hasCommand(cfg.cmd)) return { ok: false, reason: `language server「${cfg.cmd}」未安裝`, install: cfg.cmd };
  let text; try { text = readFileSync(absPath, 'utf8'); } catch (e) { return { ok: false, reason: '讀檔失敗：' + e.message }; }
  const uri = pathToFileURL(absPath).href;
  const client = createLspClient({ cmd: cfg.cmd, args: cfg.args || [], cwd });
  try {
    await client.initialize(pathToFileURL(cwd || process.cwd()).href);
    client.didOpen(uri, cfg.languageId, text);
    return { ok: true, client, uri, cfg };
  } catch (e) {
    client.shutdown();
    return { ok: false, reason: 'LSP 啟動失敗：' + (e.message || String(e)) };
  }
}

// request 加逾時（server 無回應時回 null，不永久等待）
function reqTimeout(client, method, params, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms); if (t.unref) t.unref();
    client.request(method, params).then(
      (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } },
    );
  });
}
const uriToPath = (u) => { try { return u && u.startsWith('file:') ? fileURLToPath(u) : (u || ''); } catch { return u || ''; } };
const pos1 = (r) => ({ line: (r?.start?.line ?? 0) + 1, col: (r?.start?.character ?? 0) + 1 });

// LSP position 為 0-based；工具對使用者用 1-based，這裡轉換。
const toLspPos = (line, col) => ({ line: Math.max(0, (line || 1) - 1), character: Math.max(0, (col || 1) - 1) });

// 對單一檔取 LSP 診斷。回 { ok, diagnostics:[{line,col,severity,message,source}] } 或 { ok:false, reason }。
export async function lspDiagnostics(absPath, cwd, opts = {}) {
  const ses = await openSession(absPath, cwd, opts);
  if (!ses.ok) return ses;
  try {
    const raw = await ses.client.waitDiagnostics(ses.uri, opts.timeoutMs || 8000);
    return { ok: true, diagnostics: raw.map((d) => ({ ...pos1(d.range), severity: SEVERITY[d.severity] || 'info', message: d.message, source: d.source || ses.cfg.cmd })) };
  } catch (e) { return { ok: false, reason: 'LSP 執行失敗：' + (e.message || String(e)) }; }
  finally { ses.client.shutdown(); }
}

// 跳定義：回 { ok, locations:[{file,line,col}] }。line/col 為 1-based。
export async function lspDefinition(absPath, cwd, line, col, opts = {}) {
  const ses = await openSession(absPath, cwd, opts);
  if (!ses.ok) return ses;
  try {
    const res = await reqTimeout(ses.client, 'textDocument/definition', { textDocument: { uri: ses.uri }, position: toLspPos(line, col) }, opts.timeoutMs || 8000);
    const arr = res == null ? [] : (Array.isArray(res) ? res : [res]);
    const locations = arr.map((loc) => ({ file: uriToPath(loc.uri || loc.targetUri), ...pos1(loc.range || loc.targetSelectionRange || loc.targetRange) }));
    return { ok: true, locations };
  } catch (e) { return { ok: false, reason: 'LSP 執行失敗：' + (e.message || String(e)) }; }
  finally { ses.client.shutdown(); }
}

// hover 說明（型別/簽章/文件）：回 { ok, hover:'…' }。
export async function lspHover(absPath, cwd, line, col, opts = {}) {
  const ses = await openSession(absPath, cwd, opts);
  if (!ses.ok) return ses;
  try {
    const res = await reqTimeout(ses.client, 'textDocument/hover', { textDocument: { uri: ses.uri }, position: toLspPos(line, col) }, opts.timeoutMs || 8000);
    const c = res && res.contents;
    const toStr = (x) => (typeof x === 'string' ? x : (x && x.value) || '');
    const hover = (Array.isArray(c) ? c.map(toStr).filter(Boolean).join('\n\n') : toStr(c)).trim().slice(0, 2000);
    return { ok: true, hover };
  } catch (e) { return { ok: false, reason: 'LSP 執行失敗：' + (e.message || String(e)) }; }
  finally { ses.client.shutdown(); }
}

// 檔內符號大綱：回 { ok, symbols:[{name,kind,line,depth}] }（階層以 depth 表示）。
export async function lspSymbols(absPath, cwd, opts = {}) {
  const ses = await openSession(absPath, cwd, opts);
  if (!ses.ok) return ses;
  try {
    const res = await reqTimeout(ses.client, 'textDocument/documentSymbol', { textDocument: { uri: ses.uri } }, opts.timeoutMs || 8000);
    const out = [];
    const walk = (list, depth) => {
      for (const s of (list || [])) {
        const range = s.range || s.location?.range;
        out.push({ name: s.name, kind: SYMBOL_KIND[s.kind] || String(s.kind), ...pos1(range), depth });
        if (Array.isArray(s.children)) walk(s.children, depth + 1);
      }
    };
    walk(res, 0);
    return { ok: true, symbols: out };
  } catch (e) { return { ok: false, reason: 'LSP 執行失敗：' + (e.message || String(e)) }; }
  finally { ses.client.shutdown(); }
}
