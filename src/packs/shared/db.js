// 多源資料庫核心 — 領域無關的 DB 存取抽象。
// 驅動策略：postgres/mysql 原生優先（mysql2/pg，可選依賴，TCP 直連、零 CLI）→ 未安裝則回落 CLI（psql/mysql，argv 傳參無 shell 注入）；
// sqlite 一律走 sqlite3 CLI。故「無原生套件也能跑（回落 CLI）、無 CLI 也能跑（裝原生套件）」，兩條路互為備援。
// 設計要點：
//  - 多源：一份 sources 設定描述「有哪些庫、各用什麼驅動、可做到什麼程度（read/write/admin）」。
//  - 安全：能力邊界寫在「人類配置」裡（sources.json / 建構參數），agent 只能在邊界內操作、改不了邊界；
//          破壞性 SQL 由分類器判級，寫入級別由 per-source mode 決定，密碼只從環境變數取（永不落 argv/設定）。
//  - 效能：唯讀 SELECT 自動補 LIMIT（少撈列）＋ 結果列數上限 ＋ 查詢逾時。
//  - 體驗：跨驅動統一輸出（columns/rows/rowCount/truncated），錯誤訊息點名是哪個源／缺哪個 CLI。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, delimiter } from 'node:path';

// ───────────────────────── SQL 分類（read < write < destructive）─────────────────────────

// 去掉字串常值與註解，避免關鍵字誤判（如 SELECT 'drop table x' 不該被當成 DROP）。
export function stripSql(sql) {
  let s = String(sql == null ? '' : sql);
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');   // /* 區塊註解 */
  s = s.replace(/--[^\n]*/g, ' ');           // -- 行註解
  s = s.replace(/'(?:[^']|'')*'/g, "''");    // 單引號字串（含 '' 逸出）
  s = s.replace(/"(?:[^"]|"")*"/g, '""');    // 雙引號識別字/字串
  s = s.replace(/`(?:[^`]|``)*`/g, '``');    // 反引號識別字（mysql）
  return s;
}

// 依頂層分號切成多條語句（分號已在 stripSql 後，故字串內的分號不會誤切）。
export function splitStatements(sql) {
  return stripSql(sql).split(';').map((x) => x.trim()).filter(Boolean);
}

const READ_FIRST = /^(select|with|pragma|explain|show|describe|desc|values|table)\b/i;
const DESTRUCTIVE = /\b(drop|truncate|alter|grant|revoke|attach|detach|rename|vacuum|reindex)\b/i;
const WRITE = /\b(insert|update|delete|create|replace|merge|upsert|call)\b/i;
const LEVEL_ORDER = { empty: -1, read: 0, write: 1, destructive: 2 };

// 回傳整段 SQL 的最高風險級別（多語句取最嚴）。
export function classifySql(sql) {
  const stmts = splitStatements(sql);
  if (!stmts.length) return { level: 'empty', statements: 0 };
  let level = 'read';
  const bump = (l) => { if (LEVEL_ORDER[l] > LEVEL_ORDER[level]) level = l; };
  for (const st of stmts) {
    const hasWhere = /\bwhere\b/i.test(st);
    if (DESTRUCTIVE.test(st)) { bump('destructive'); continue; }
    // DELETE/UPDATE 無 WHERE → 全表覆寫，視為破壞性（含 CTE 前導的 WITH ... DELETE）。
    if (/\b(delete|update)\b/i.test(st)) { bump(hasWhere ? 'write' : 'destructive'); continue; }
    if (WRITE.test(st)) { bump('write'); continue; }
    if (READ_FIRST.test(st)) { bump('read'); continue; }
    bump('write'); // 認不得的語句 → 保守當寫入（唯讀源會擋、寫入源放行）
  }
  return { level, statements: stmts.length };
}

// 單條、無 LIMIT 的 SELECT → 可安全在尾端補 LIMIT（少撈列，兼作截斷偵測）。
export function needsAutoLimit(sql) {
  const stmts = splitStatements(sql);
  if (stmts.length !== 1) return false;
  const s = stmts[0];
  return /^\s*select\b/i.test(s) && !/\blimit\b/i.test(s);
}
export function applyAutoLimit(sql, n) {
  if (!needsAutoLimit(sql)) return sql;
  return `${String(sql).trim().replace(/;\s*$/, '')} LIMIT ${n}`;
}

// 識別字白名單：只允許字母/數字/底線/$/點（schema.table），擋掉引號、分號、空白等注入面。
export function isSafeIdent(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_$.]+$/.test(name);
}

// ───────────────────────── CLI / 解析輔助 ─────────────────────────

const MAX_BUFFER = 32 * 1024 * 1024;

const IS_WIN = process.platform === 'win32';
// Windows 可執行副檔名（spawn 不做 PATHEXT 解析 → 明確補上）；Unix 只有裸名。
const EXE_EXTS = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
// Unix 常見 CLI 目錄（補 PATH：GUI/launchd/容器起的 node 進程常缺 homebrew 路徑，「明明裝了卻找不到」）。
const UNIX_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/opt/local/bin', '/snap/bin'];

// Windows：DB client 安裝根（版本目錄不定 → 掃 <ProgramFiles>/<vendor>/*/bin）。
function winDbDirs(cmd) {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean);
  const vendors = /^psql/.test(cmd) ? ['PostgreSQL'] : /^mysql/.test(cmd) ? ['MySQL', 'MariaDB'] : /^sqlite/.test(cmd) ? ['SQLite'] : [];
  const out = [];
  for (const root of roots) for (const v of vendors) {
    const vdir = join(root, v);
    try { for (const sub of readdirSync(vdir)) { const b = join(vdir, sub, 'bin'); if (existsSync(b)) out.push(b); } } catch { /* 目錄不存在略過 */ }
  }
  return out;
}

// 解析 CLI 絕對路徑（跨 Windows / macOS / Linux）：環境變數覆寫 > PATH > 平台常見目錄；
// 都找不到 → 回裸命令（Windows 補 .exe）交給 spawn 產生 ENOENT + 可操作訊息。
export function resolveBin(cmd, envVar) {
  const override = envVar && process.env[envVar];
  if (override) return override; // 明確指定就用（不存在也讓 spawn 報，訊息更直白）
  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const extraDirs = IS_WIN ? winDbDirs(cmd) : UNIX_BIN_DIRS;
  for (const d of [...pathDirs, ...extraDirs]) {
    for (const ext of EXE_EXTS) {
      try { const p = join(d, cmd + ext); if (existsSync(p)) return p; } catch { /* 略 */ }
    }
  }
  return IS_WIN ? cmd + '.exe' : cmd;
}

// 多個候選命令名，回第一個能解析到實體路徑的（如 mysql 在 Alpine/MariaDB 環境可能只叫 mariadb）。
function firstBin(cmds, envVar) {
  const override = envVar && process.env[envVar];
  if (override) return override;
  for (const c of cmds) { const r = resolveBin(c, null); if (isAbsolute(r)) return r; }
  return resolveBin(cmds[0], null); // 都沒裝 → 回第一個裸名，觸發 ENOENT + 可操作訊息
}

function run(cmd, args, { env, timeout, input, notFound } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', timeout: timeout ?? 30000, maxBuffer: MAX_BUFFER,
    env: env ? { ...process.env, ...env } : process.env,
    ...(input != null ? { input } : {}),
  });
  if (r.error) return { error: r.error.code === 'ENOENT' ? (notFound || `找不到 ${cmd} 命令（請先安裝）`) : r.error.message };
  if (r.status !== 0) return { error: (r.stderr || '').trim() || `exit ${r.status}` };
  return { out: r.stdout || '' };
}

// 各 CLI 缺失時的可操作指引（跨平台：macOS / Linux / Alpine-Docker / Windows + 環境變數覆寫）。
const NOT_FOUND = {
  sqlite: '找不到 sqlite3：server 主機需安裝。macOS: brew install sqlite｜Debian/Ubuntu: apt install sqlite3｜Alpine/Docker: apk add sqlite｜Windows: 下載 sqlite3.exe 並加入 PATH（或設 XITTO_SQLITE_BIN 指定完整路徑）。',
  postgres: '找不到 psql：需安裝 PostgreSQL client。macOS: brew install libpq（bin 加入 PATH）｜Debian/Ubuntu: apt install postgresql-client｜Alpine/Docker: apk add postgresql-client｜Windows: 裝 PostgreSQL 並把 ...\\PostgreSQL\\<版本>\\bin 加入 PATH（或設 XITTO_PSQL_BIN）。',
  mysql: '找不到 mysql 客户端：需安裝 MySQL/MariaDB client。macOS: brew install mysql-client（確認在 PATH）｜Debian/Ubuntu: apt install default-mysql-client｜Alpine/Docker: apk add mariadb-client｜Windows: 裝 MySQL 並把 ...\\bin 加入 PATH（或設 XITTO_MYSQL_BIN）。',
};

// RFC4180 風格 CSV 解析（處理引號、逸出雙引號、跨行欄位）→ 二維陣列。
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let inQ = false; let started = false;
  const t = String(text == null ? '' : text);
  for (let i = 0; i < t.length; i++) {
    const c = t[i]; started = true;
    if (inQ) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* 忽略 */ }
    else field += c;
  }
  if (field.length || row.length || (started && !rows.length)) { row.push(field); rows.push(row); }
  return rows;
}

// TSV（mysql --batch）解析：以換行分列、tab 分欄。
export function parseTsv(text) {
  return String(text == null ? '' : text).replace(/\r/g, '').split('\n').filter((l, i, a) => l.length || i < a.length - 1)
    .map((l) => l.split('\t'));
}

// 二維矩陣（首列表頭）→ 統一結果，套用列數上限。
function tableFromMatrix(matrix, maxRows) {
  if (!matrix.length) return { columns: [], rows: [], rowCount: 0, truncated: false };
  const [head, ...body] = matrix;
  const truncated = body.length > maxRows;
  return { columns: head, rows: truncated ? body.slice(0, maxRows) : body, rowCount: body.length, truncated };
}

// 統一結果 → CSV 文字（含表頭；欄位視需要加引號），給模型/使用者複製貼上。
export function toCsv({ columns, rows }) {
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns, ...rows].map((r) => r.map(q).join(',')).join('\n');
}

// ───────────────────────── 驅動（每個都：listTables / describeTable / query / exec）─────────────────────────

// 密碼解析：直接存的 password 優先，否則從 passwordEnv 指名的環境變數取（都沒有 → undefined）。
function resolvePassword(src) {
  if (src.password) return String(src.password);
  if (src.passwordEnv && process.env[src.passwordEnv]) return String(process.env[src.passwordEnv]);
  return undefined;
}

function pgEnv(src) {
  const env = {};
  if (src.host) env.PGHOST = String(src.host);
  if (src.port != null) env.PGPORT = String(src.port);
  if (src.database) env.PGDATABASE = String(src.database);
  if (src.user) env.PGUSER = String(src.user);
  const pw = resolvePassword(src);
  if (pw) env.PGPASSWORD = pw;
  env.PGCONNECT_TIMEOUT = String(Math.ceil((src.timeout ?? 30000) / 1000));
  return env;
}

function mysqlArgs(src) {
  const a = [];
  if (src.host) a.push('-h', String(src.host));
  if (src.port != null) a.push('-P', String(src.port));
  if (src.user) a.push('-u', String(src.user));
  if (src.database) a.push(String(src.database));
  return a;
}
function mysqlEnv(src) {
  const pw = resolvePassword(src);
  return pw ? { MYSQL_PWD: pw } : {}; // 密碼走 MYSQL_PWD，不落 argv
}

// 原生驅動回傳的列物件陣列 → 統一結果（columns/rows/rowCount/truncated），套用列數上限。
function rowsToTable(rows, columns, maxRows) {
  const cols = columns && columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
  const body = rows.map((row) => cols.map((c) => row[c]));
  const truncated = body.length > maxRows;
  return { columns: cols, rows: truncated ? body.slice(0, maxRows) : body, rowCount: body.length, truncated };
}

// ── sqlite（CLI，唯一路徑：本地單檔、sqlite3 極小，不上原生驅動避免編譯 better-sqlite3）──
function sqliteCli(src) {
  const timeout = src.timeout ?? 30000, maxRows = src.maxRows ?? 1000;
  const BIN = resolveBin('sqlite3', 'XITTO_SQLITE_BIN'), nf = NOT_FOUND.sqlite;
  return {
    engine: 'sqlite', native: false,
    listTables() { const r = run(BIN, [src.file, '.tables'], { timeout, notFound: nf }); return r.error ? r : { tables: (r.out || '').split(/\s+/).filter(Boolean) }; },
    describeTable(table) { if (!isSafeIdent(table)) return { error: '表名含非法字元' }; const r = run(BIN, [src.file, `.schema ${table}`], { timeout, notFound: nf }); return r.error ? r : { schema: (r.out || '').trim() || '(無此表)' }; },
    query(sql) { const r = run(BIN, ['-header', '-csv', src.file, applyAutoLimit(sql, maxRows + 1)], { timeout, notFound: nf }); return r.error ? r : tableFromMatrix(parseCsv(r.out), maxRows); },
    exec(sql) { const r = run(BIN, [src.file, sql], { timeout, notFound: nf }); return r.error ? r : { ok: true, out: (r.out || '').trim() }; },
  };
}

// ── postgres（CLI 回落：psql）──
function pgCli(src) {
  const timeout = src.timeout ?? 30000, maxRows = src.maxRows ?? 1000;
  const BIN = resolveBin('psql', 'XITTO_PSQL_BIN');
  const base = ['-v', 'ON_ERROR_STOP=1', '--csv'];
  const connArg = src.url ? [src.url] : [];
  const psql = (sql) => run(BIN, [...connArg, ...base, '-c', sql], { env: src.url ? {} : pgEnv(src), timeout, notFound: NOT_FOUND.postgres });
  return {
    engine: 'postgres', native: false,
    listTables() { const r = psql("SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1"); if (r.error) return r; return { tables: parseCsv(r.out).slice(1).map((row) => row[0]).filter(Boolean) }; },
    describeTable(table) {
      if (!isSafeIdent(table)) return { error: '表名含非法字元' };
      const t = table.includes('.') ? table.split('.').pop() : table;
      const r = psql(`SELECT column_name || ' ' || data_type || CASE WHEN is_nullable='NO' THEN ' NOT NULL' ELSE '' END FROM information_schema.columns WHERE table_name='${t}' ORDER BY ordinal_position`);
      if (r.error) return r;
      const cols = parseCsv(r.out).slice(1).map((row) => row[0]).filter(Boolean);
      return { schema: cols.length ? cols.join('\n') : '(無此表或無欄位)' };
    },
    query(sql) { const r = psql(applyAutoLimit(sql, maxRows + 1)); return r.error ? r : tableFromMatrix(parseCsv(r.out), maxRows); },
    exec(sql) { const r = psql(sql); return r.error ? r : { ok: true, out: (r.out || '').trim() }; },
  };
}

// ── mysql（CLI 回落：mysql / mariadb）──
function mysqlCli(src) {
  const timeout = src.timeout ?? 30000, maxRows = src.maxRows ?? 1000;
  const BIN = firstBin(['mysql', 'mariadb'], 'XITTO_MYSQL_BIN'); // Alpine/MariaDB 可能只有 mariadb
  const my = (sql) => run(BIN, [...mysqlArgs(src), '--batch', '-e', sql], { env: mysqlEnv(src), timeout, notFound: NOT_FOUND.mysql });
  return {
    engine: 'mysql', native: false,
    listTables() {
      const sql = src.database ? 'SHOW TABLES'
        : "SELECT concat(table_schema,'.',table_name) FROM information_schema.tables WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1";
      const r = my(sql); if (r.error) return r;
      return { tables: parseTsv(r.out).slice(1).map((row) => row[0]).filter(Boolean) };
    },
    describeTable(table) {
      if (!isSafeIdent(table)) return { error: '表名含非法字元' };
      const wrapped = table.includes('.') ? table.split('.').map((p) => `\`${p}\``).join('.') : `\`${table}\``;
      const r = my(`SHOW CREATE TABLE ${wrapped}`); if (r.error) return r;
      const rows = parseTsv(r.out);
      return { schema: (rows[1] && rows[1][1]) ? rows[1][1] : '(無此表)' };
    },
    query(sql) { const r = my(applyAutoLimit(sql, maxRows + 1)); return r.error ? r : tableFromMatrix(parseTsv(r.out), maxRows); },
    exec(sql) { const r = my(sql); return r.error ? r : { ok: true, out: (r.out || '').trim() }; },
  };
}

// ── postgres（原生 pg，優先；每次呼叫獨立連線 → 不跨 run 洩漏連線）──
async function pgNative(src) {
  const { default: pg } = await import('pg'); // 未安裝 → 拋錯，由 createDriver 回落 CLI
  const Client = pg.Client;
  const timeout = src.timeout ?? 30000, maxRows = src.maxRows ?? 1000;
  const cfg = src.url
    ? { connectionString: src.url, connectionTimeoutMillis: timeout, statement_timeout: timeout, query_timeout: timeout }
    : { host: src.host, port: src.port || 5432, database: src.database, user: src.user, password: resolvePassword(src), connectionTimeoutMillis: timeout, statement_timeout: timeout, query_timeout: timeout };
  const withClient = async (fn) => {
    const client = new Client(cfg);
    try { await client.connect(); return await fn(client); }
    catch (e) { return { error: e.message }; }
    finally { try { await client.end(); } catch { /* 略 */ } }
  };
  return {
    engine: 'postgres', native: true,
    listTables: () => withClient(async (c) => { const r = await c.query("SELECT table_schema||'.'||table_name AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1"); return { tables: r.rows.map((row) => row.t).filter(Boolean) }; }),
    describeTable: (table) => {
      if (!isSafeIdent(table)) return Promise.resolve({ error: '表名含非法字元' });
      const [schema, name] = table.includes('.') ? table.split('.') : [null, table];
      return withClient(async (c) => {
        const r = await c.query(
          "SELECT column_name || ' ' || data_type || CASE WHEN is_nullable='NO' THEN ' NOT NULL' ELSE '' END AS d FROM information_schema.columns WHERE table_name=$1" + (schema ? ' AND table_schema=$2' : '') + ' ORDER BY ordinal_position',
          schema ? [name, schema] : [name]);
        return { schema: r.rows.length ? r.rows.map((row) => row.d).join('\n') : '(無此表或無欄位)' };
      });
    },
    query: (sql) => withClient(async (c) => { const r = await c.query(applyAutoLimit(sql, maxRows + 1)); return rowsToTable(r.rows, (r.fields || []).map((f) => f.name), maxRows); }),
    exec: (sql) => withClient(async (c) => { const r = await c.query(sql); return { ok: true, out: r.rowCount != null ? `rowCount: ${r.rowCount}` : '' }; }),
  };
}

// ── mysql（原生 mysql2，優先；每次呼叫獨立連線）──
async function mysqlNative(src) {
  const mysql = await import('mysql2/promise'); // 未安裝 → 拋錯，由 createDriver 回落 CLI
  const createConnection = mysql.createConnection || (mysql.default && mysql.default.createConnection);
  const timeout = src.timeout ?? 30000, maxRows = src.maxRows ?? 1000;
  const connCfg = { host: src.host, port: src.port || 3306, user: src.user, password: resolvePassword(src), database: src.database || undefined, connectTimeout: timeout, multipleStatements: false };
  const withConn = async (fn) => {
    let conn;
    try { conn = await createConnection(connCfg); return await fn(conn); }
    catch (e) { return { error: e.message }; }
    finally { if (conn) try { await conn.end(); } catch { /* 略 */ } }
  };
  const runQ = (conn, sql) => conn.query({ sql, timeout });
  return {
    engine: 'mysql', native: true,
    listTables: () => withConn(async (conn) => {
      const sql = src.database ? 'SHOW TABLES'
        : "SELECT concat(table_schema,'.',table_name) AS t FROM information_schema.tables WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1";
      const [rows] = await runQ(conn, sql);
      return { tables: rows.map((r) => Object.values(r)[0]).filter(Boolean) };
    }),
    describeTable: (table) => {
      if (!isSafeIdent(table)) return Promise.resolve({ error: '表名含非法字元' });
      const wrapped = table.includes('.') ? table.split('.').map((p) => `\`${p}\``).join('.') : `\`${table}\``;
      return withConn(async (conn) => { const [rows] = await runQ(conn, `SHOW CREATE TABLE ${wrapped}`); const r0 = rows[0]; return { schema: r0 ? (r0['Create Table'] || Object.values(r0)[1] || '(無此表)') : '(無此表)' }; });
    },
    query: (sql) => withConn(async (conn) => { const [rows, fields] = await runQ(conn, applyAutoLimit(sql, maxRows + 1)); return rowsToTable(rows, (fields || []).map((f) => f.name), maxRows); }),
    exec: (sql) => withConn(async (conn) => { const [res] = await runQ(conn, sql); return { ok: true, out: (res && res.affectedRows != null) ? `affectedRows: ${res.affectedRows}` : '' }; }),
  };
}

/**
 * 建驅動（async）。策略：pg/mysql 原生優先（mysql2/pg，TCP 直連、零 CLI 依賴），
 * 未安裝該套件 → 回落 CLI（psql/mysql）。sqlite 一律 CLI。
 */
export async function createDriver(src) {
  if (src.driver === 'sqlite') return sqliteCli(src);
  if (src.driver === 'postgres') { try { return await pgNative(src); } catch { return pgCli(src); } }
  if (src.driver === 'mysql') { try { return await mysqlNative(src); } catch { return mysqlCli(src); } }
  return {
    engine: src.driver, native: false,
    listTables: () => ({ error: `未知驅動 ${src.driver}` }),
    describeTable: () => ({ error: `未知驅動 ${src.driver}` }),
    query: () => ({ error: `未知驅動 ${src.driver}` }),
    exec: () => ({ error: `未知驅動 ${src.driver}` }),
  };
}

// ───────────────────────── 多源設定解析 ─────────────────────────

const DRIVERS = new Set(['sqlite', 'postgres', 'mysql']);
const MODES = new Set(['read', 'write', 'admin']);

function normalizeSource(name, sc, cwd) {
  if (!sc || typeof sc !== 'object') return { error: `源「${name}」設定需為物件` };
  let driver = String(sc.driver || 'sqlite').toLowerCase();
  if (driver === 'postgresql' || driver === 'pg') driver = 'postgres';
  if (!DRIVERS.has(driver)) return { error: `源「${name}」未知驅動 ${driver}（支援 sqlite/postgres/mysql）` };
  let mode = String(sc.mode || (sc.readOnly ? 'read' : 'read')).toLowerCase();
  if (!MODES.has(mode)) mode = 'read';
  const src = {
    name, driver, mode,
    timeout: Number.isFinite(sc.timeout) ? sc.timeout : 30000,
    maxRows: Number.isFinite(sc.maxRows) ? sc.maxRows : 1000,
  };
  if (driver === 'sqlite') {
    src.file = sc.file ? (isAbsolute(sc.file) ? sc.file : join(cwd, sc.file)) : join(cwd, 'data.db');
  } else {
    src.url = sc.url; src.host = sc.host || '127.0.0.1'; src.port = sc.port;
    src.database = sc.database; src.user = sc.user;
    src.passwordEnv = sc.passwordEnv;      // 環境變數名（推薦：密碼不落設定檔）
    src.password = sc.password;            // 或直接存密碼（UI 存的；與 stt.json 存 apiKey 同慣例）
  }
  return { src };
}

/**
 * 解析多源設定。優先序：顯式 sources 參數 > 設定檔 > 舊 db 參數 > 預設單一 sqlite。
 * @returns {{ sources: Map<string, object>, defaultSource: string, error?: string, warnings: string[] }}
 */
export function loadSources({ cwd = process.cwd(), configPath, sources, db } = {}) {
  const warnings = [];
  let cfg = null; let parseError;
  if (sources && typeof sources === 'object') {
    cfg = { sources, defaultSource: undefined };
  } else {
    const path = configPath || join(cwd, '.xitto-kernel', 'data-query', 'sources.json');
    if (existsSync(path)) {
      try { cfg = JSON.parse(readFileSync(path, 'utf8')); }
      catch { parseError = 'sources.json 解析失敗，改用預設單一資料源'; }
    }
  }

  const out = new Map();
  if (cfg && cfg.sources && typeof cfg.sources === 'object') {
    for (const [name, sc] of Object.entries(cfg.sources)) {
      const { src, error } = normalizeSource(name, sc, cwd);
      if (error) { warnings.push(error); continue; }
      out.set(name, src);
    }
  }

  if (!out.size) {
    // 回落：相容既有 createDataQueryPack({ db }) —— 單一 sqlite，預設可寫但不可破壞。
    const file = db ? (isAbsolute(db) ? db : join(cwd, db)) : join(cwd, 'data.db');
    out.set('main', { name: 'main', driver: 'sqlite', mode: 'write', file, timeout: 30000, maxRows: 1000 });
  }

  const defaultSource = (cfg && cfg.defaultSource && out.has(cfg.defaultSource)) ? cfg.defaultSource : [...out.keys()][0];
  return { sources: out, defaultSource, error: parseError, warnings };
}
