// data-query pack — 多源 + 安全守衛 + 效能（自動 LIMIT/截斷）測試。
// 用真實 sqlite3 CLI（本機必備，既有 pack 已依賴）；postgres/mysql 驅動不在此測（無 server），
// 改由 classifySql / loadSources 等純函數單測涵蓋跨驅動共用邏輯。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDataQueryPack } from '../src/packs/data-query/index.js';
import { classifySql, applyAutoLimit, needsAutoLimit, loadSources, parseCsv, toCsv, resolveBin, createDriver } from '../src/packs/shared/db.js';

const hasSqlite = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;

// 建一個測試 sqlite 庫
function mkDb(dir, file, rows = 3) {
  const path = join(dir, file);
  const seed = 'CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT); ' +
    Array.from({ length: rows }, (_, i) => `INSERT INTO t(name) VALUES('n${i}');`).join(' ');
  const r = spawnSync('sqlite3', [path, seed], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return path;
}

const text = (res) => res.content[0].text;
const parse = (res) => { try { return JSON.parse(text(res)); } catch { return text(res); } };

// ───────────────────────── 純函數：SQL 分類 ─────────────────────────

test('classifySql · 唯讀 / 寫入 / 破壞性 分級', () => {
  assert.equal(classifySql('SELECT * FROM t').level, 'read');
  assert.equal(classifySql('WITH x AS (SELECT 1) SELECT * FROM x').level, 'read');
  assert.equal(classifySql('PRAGMA table_info(t)').level, 'read');
  assert.equal(classifySql("INSERT INTO t(name) VALUES('a')").level, 'write');
  assert.equal(classifySql('UPDATE t SET name=1 WHERE id=1').level, 'write');
  assert.equal(classifySql('DELETE FROM t WHERE id=1').level, 'write');
  assert.equal(classifySql('DROP TABLE t').level, 'destructive');
  assert.equal(classifySql('TRUNCATE TABLE t').level, 'destructive');
  assert.equal(classifySql('ALTER TABLE t ADD COLUMN c INT').level, 'destructive');
});

test('classifySql · 無 WHERE 的 DELETE/UPDATE 視為破壞性', () => {
  assert.equal(classifySql('DELETE FROM t').level, 'destructive');
  assert.equal(classifySql('UPDATE t SET name=1').level, 'destructive');
});

test('classifySql · 字串常值內的關鍵字不誤判', () => {
  assert.equal(classifySql("SELECT * FROM t WHERE name='drop table users'").level, 'read');
  assert.equal(classifySql("SELECT 'DELETE everything'").level, 'read');
});

test('classifySql · 多語句取最嚴（防夾帶）', () => {
  assert.equal(classifySql('SELECT 1; DROP TABLE t').level, 'destructive');
  assert.equal(classifySql("SELECT 1; INSERT INTO t VALUES(1,'a')").level, 'write');
  assert.equal(classifySql('SELECT 1; SELECT 2').statements, 2);
});

test('needsAutoLimit / applyAutoLimit · 只對單條無 LIMIT 的 SELECT 動作', () => {
  assert.equal(needsAutoLimit('SELECT * FROM t'), true);
  assert.equal(needsAutoLimit('SELECT * FROM t LIMIT 5'), false);
  assert.equal(needsAutoLimit('SELECT 1; SELECT 2'), false);
  assert.equal(needsAutoLimit("INSERT INTO t VALUES(1,'a')"), false);
  assert.equal(applyAutoLimit('SELECT * FROM t', 100), 'SELECT * FROM t LIMIT 100');
  assert.equal(applyAutoLimit('SELECT * FROM t LIMIT 5', 100), 'SELECT * FROM t LIMIT 5');
});

test('resolveBin · 環境變數覆寫 > 常見目錄補 PATH > 回落裸命令', () => {
  // sqlite3 本機必裝 → 應解析出絕對路徑（PATH 或 /usr/bin 等常見目錄）
  const sq = resolveBin('sqlite3', 'XITTO_SQLITE_BIN');
  assert.ok(sq.endsWith('sqlite3'));
  // 完全不存在 → 回裸命令（交給 spawn 產生 ENOENT + 可操作訊息）
  assert.equal(resolveBin('definitely-no-such-bin-xyz', 'X_NONE_ENV'), 'definitely-no-such-bin-xyz');
  // 環境變數覆寫優先（即便路徑不存在也直接用 → 訊息更直白）
  const prev = process.env.XITTO_TEST_BIN;
  process.env.XITTO_TEST_BIN = '/custom/mysql';
  try { assert.equal(resolveBin('mysql', 'XITTO_TEST_BIN'), '/custom/mysql'); }
  finally { if (prev === undefined) delete process.env.XITTO_TEST_BIN; else process.env.XITTO_TEST_BIN = prev; }
});

test('resolveBin · 依 PATH（跨平台 delimiter）找到自訂目錄的可執行檔', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-bin-'));
  const prevPath = process.env.PATH;
  try {
    const name = 'xitto-fake-tool';
    const exe = name + (process.platform === 'win32' ? '.exe' : '');
    writeFileSync(join(dir, exe), '');
    process.env.PATH = dir + (process.platform === 'win32' ? ';' : ':') + (prevPath || '');
    assert.equal(resolveBin(name, 'X_NONE'), join(dir, exe));
  } finally { process.env.PATH = prevPath; rmSync(dir, { recursive: true, force: true }); }
});

test('createDriver · 引擎分派 + 原生(mysql2/pg)缺失回落 CLI', async () => {
  // 是否裝了原生套件（不管裝沒裝，行為都要對）
  const has = async (m) => { try { await import(m); return true; } catch { return false; } };
  const hasMysql2 = await has('mysql2/promise'), hasPg = await has('pg');

  const my = await createDriver({ driver: 'mysql', host: 'h', database: 'd', user: 'u' });
  assert.equal(my.engine, 'mysql');
  assert.equal(typeof my.query, 'function');
  assert.equal(my.native, hasMysql2, '裝了 mysql2 → 原生；否則回落 CLI');

  const pg = await createDriver({ driver: 'postgres', host: 'h', database: 'd', user: 'u' });
  assert.equal(pg.engine, 'postgres');
  assert.equal(pg.native, hasPg);

  const sq = await createDriver({ driver: 'sqlite', file: '/tmp/x.db' });
  assert.equal(sq.engine, 'sqlite');
  assert.equal(sq.native, false, 'sqlite 一律 CLI');

  const un = await createDriver({ driver: 'oracle' });
  const r = await un.listTables();
  assert.match(r.error, /未知驅動/);
});

test('parseCsv / toCsv · 引號與逗號往返', () => {
  const m = parseCsv('a,b\n1,"x,y"\n2,"say ""hi"""');
  assert.deepEqual(m[0], ['a', 'b']);
  assert.deepEqual(m[1], ['1', 'x,y']);
  assert.deepEqual(m[2], ['2', 'say "hi"']);
  assert.equal(toCsv({ columns: ['a'], rows: [['x,y']] }), 'a\n"x,y"');
});

// ───────────────────────── 多源設定解析 ─────────────────────────

test('loadSources · 無設定 → 回落單一 sqlite（write 級，相容舊 db 參數）', () => {
  const { sources, defaultSource } = loadSources({ cwd: '/tmp/x', db: 'my.db' });
  assert.equal(sources.size, 1);
  assert.equal(defaultSource, 'main');
  const s = sources.get('main');
  assert.equal(s.driver, 'sqlite');
  assert.equal(s.mode, 'write');
  assert.match(s.file, /my\.db$/);
});

test('loadSources · 顯式多源 + 預設 + 未知驅動略過', () => {
  const { sources, defaultSource, warnings } = loadSources({
    cwd: '/tmp/x',
    sources: {
      a: { driver: 'sqlite', file: 'a.db', mode: 'read' },
      b: { driver: 'postgres', host: 'h', database: 'd', user: 'u', mode: 'write' },
      bad: { driver: 'oracle' },
    },
  });
  assert.equal(sources.size, 2);
  assert.equal(sources.get('a').mode, 'read');
  assert.equal(sources.get('b').driver, 'postgres');
  assert.ok(warnings.some((w) => /oracle/.test(w)));
  assert.equal(defaultSource, 'a'); // 第一個
});

test('createDataQueryPack · sourcesPath 讀外部設定檔（server 注入路徑）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-sp-'));
  try {
    const file = join(dir, 'data-sources.json');
    writeFileSync(file, JSON.stringify({ sources: { wh: { driver: 'sqlite', file: 'x.db', mode: 'read' }, ops: { driver: 'postgres', host: 'h', database: 'd', mode: 'write' } }, defaultSource: 'ops' }));
    const pack = createDataQueryPack({ cwd: dir, sourcesPath: file });
    const names = pack.tools().map((t) => t.name);
    assert.ok(names.includes('list_sources'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadSources · sourcesPath + defaultSource 生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-sp2-'));
  try {
    const file = join(dir, 'ds.json');
    writeFileSync(file, JSON.stringify({ sources: { a: { driver: 'sqlite', file: 'a.db' }, b: { driver: 'sqlite', file: 'b.db' } }, defaultSource: 'b' }));
    const { sources, defaultSource } = loadSources({ cwd: dir, configPath: file });
    assert.equal(sources.size, 2);
    assert.equal(defaultSource, 'b');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadSources · readOnly:true → mode read；非法 mode → 退回 read', () => {
  const { sources } = loadSources({ cwd: '/tmp/x', sources: {
    a: { driver: 'sqlite', readOnly: true },
    b: { driver: 'sqlite', mode: 'god' },
  } });
  assert.equal(sources.get('a').mode, 'read');
  assert.equal(sources.get('b').mode, 'read');
});

// ───────────────────────── pack 守衛（守衛鏈第 3 格）─────────────────────────

test('schema-before-query：沒先看結構就下 SQL → 擋', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-sbq-'));
  try {
    mkDb(dir, 'data.db');
    const pack = createDataQueryPack({ cwd: dir });
    const blocked = await pack.preToolPolicy.check({ name: 'sql_query', args: { sql: 'SELECT * FROM t' } });
    assert.equal(blocked?.block, true);
    assert.match(blocked.reason, /尚未看過結構/);
    // 看過結構後放行
    await pack.tools().find((t) => t.name === 'list_tables').execute('1', {});
    const ok = await pack.preToolPolicy.check({ name: 'sql_query', args: { sql: 'SELECT * FROM t' } });
    assert.equal(ok, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('讀寫分流：sql_query 不接受寫入型 SQL', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-rw-'));
  try {
    mkDb(dir, 'data.db');
    const pack = createDataQueryPack({ cwd: dir });
    await pack.tools().find((t) => t.name === 'list_tables').execute('1', {});
    const b = await pack.preToolPolicy.check({ name: 'sql_query', args: { sql: "INSERT INTO t(name) VALUES('z')" } });
    assert.equal(b?.block, true);
    assert.match(b.reason, /sql_exec/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('per-source mode：read 擋寫入、write 擋破壞、admin 全開', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-mode-'));
  try {
    mkDb(dir, 'r.db'); mkDb(dir, 'w.db'); mkDb(dir, 'a.db');
    const pack = createDataQueryPack({ cwd: dir, sources: {
      r: { driver: 'sqlite', file: 'r.db', mode: 'read' },
      w: { driver: 'sqlite', file: 'w.db', mode: 'write' },
      a: { driver: 'sqlite', file: 'a.db', mode: 'admin' },
    } });
    const lt = pack.tools().find((t) => t.name === 'list_tables');
    for (const s of ['r', 'w', 'a']) await lt.execute('1', { source: s });
    const chk = (source, sql) => pack.preToolPolicy.check({ name: 'sql_exec', args: { source, sql } });

    // read：任何寫入都擋
    assert.match((await chk('r', "INSERT INTO t(name) VALUES('x')")).reason, /唯讀/);
    // write：INSERT 放行、DROP 擋
    assert.equal(await chk('w', "INSERT INTO t(name) VALUES('x')"), undefined);
    assert.match((await chk('w', 'DROP TABLE t')).reason, /破壞性|admin/);
    // admin：DROP 也放行
    assert.equal(await chk('a', 'DROP TABLE t'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('未知資料源 → 擋，並列出可用源', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-unk-'));
  try {
    mkDb(dir, 'data.db');
    const pack = createDataQueryPack({ cwd: dir });
    const b = await pack.preToolPolicy.check({ name: 'sql_query', args: { source: 'nope', sql: 'SELECT 1' } });
    assert.equal(b?.block, true);
    assert.match(b.reason, /未知資料源.*main/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('端到端：多源查詢隔離 + list_sources', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-e2e-'));
  try {
    mkDb(dir, 'a.db', 2); mkDb(dir, 'b.db', 5);
    const pack = createDataQueryPack({ cwd: dir, sources: {
      a: { driver: 'sqlite', file: 'a.db', mode: 'read' },
      b: { driver: 'sqlite', file: 'b.db', mode: 'read' },
    } });
    const tool = (n) => pack.tools().find((t) => t.name === n);
    const srcs = parse(await tool('list_sources').execute('1', {}));
    assert.equal(srcs.sources.length, 2);
    for (const s of ['a', 'b']) await tool('list_tables').execute('1', { source: s });
    const ra = text(await tool('sql_query').execute('1', { source: 'a', sql: 'SELECT count(*) AS n FROM t' }));
    const rb = text(await tool('sql_query').execute('1', { source: 'b', sql: 'SELECT count(*) AS n FROM t' }));
    assert.match(ra, /\bn\b[\s\S]*2/);
    assert.match(rb, /\bn\b[\s\S]*5/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('效能：大結果自動 LIMIT + 截斷提示', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-lim-'));
  try {
    mkDb(dir, 'data.db', 50);
    const pack = createDataQueryPack({ cwd: dir, sources: {
      main: { driver: 'sqlite', file: 'data.db', mode: 'read', maxRows: 10 },
    } });
    const tool = (n) => pack.tools().find((t) => t.name === n);
    await tool('list_tables').execute('1', {});
    const out = text(await tool('sql_query').execute('1', { sql: 'SELECT * FROM t' }));
    assert.match(out, /已截斷/);
    // 只回 maxRows 列（+表頭）
    assert.equal(out.split('\n').filter((l) => /^\d+,/.test(l)).length, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('破壞性守衛端到端：write 源 DROP 被硬擋、資料未失', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-drop-'));
  try {
    mkDb(dir, 'data.db', 3);
    const pack = createDataQueryPack({ cwd: dir }); // 預設 main = write
    const tool = (n) => pack.tools().find((t) => t.name === n);
    await tool('list_tables').execute('1', {});
    const guard = await pack.preToolPolicy.check({ name: 'sql_exec', args: { sql: 'DROP TABLE t' } });
    assert.equal(guard?.block, true); // 守衛擋下 → execute 永不被呼叫
    // 表仍在
    const still = text(await tool('sql_query').execute('1', { sql: 'SELECT count(*) AS n FROM t' }));
    assert.match(still, /3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
