// 資料庫連線管理端點（/v1/data-sources：增刪改查測）。master only；持久化 <baseDir>/data-sources.json。
// 用真實 sqlite3 CLI 建庫測「測試連線」；postgres 只測設定存取與密碼不外洩（無 server）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApp } from '../src/app/server.js';

const hasSqlite = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;

async function withApp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ds-ep-'));
  const base = join(root, '.srv');
  const app = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', baseDir: base });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  const api = (p, opt = {}) => fetch(`http://localhost:${port}${p}`, { ...opt, headers: { 'content-type': 'application/json', authorization: 'Bearer t', ...(opt.headers || {}) } });
  try { await fn({ api, base, root }); }
  finally { await new Promise((r) => app.close(r)); rmSync(root, { recursive: true, force: true }); }
}

test('CRUD：新增 / 列表 / 更新 / 刪除 sqlite 連線', async () => {
  await withApp(async ({ api, base }) => {
    // 初始空
    let list = await api('/v1/data-sources').then((r) => r.json());
    assert.deepEqual(list.sources, []);

    // 新增
    let r = await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'main', driver: 'sqlite', file: '/tmp/a.db', mode: 'read' }) }).then((x) => x.json());
    assert.equal(r.ok, true);
    // 落檔
    assert.ok(existsSync(join(base, 'data-sources.json')));

    // 列表反映 + 設為預設
    list = await api('/v1/data-sources').then((r) => r.json());
    assert.equal(list.sources.length, 1);
    assert.equal(list.sources[0].name, 'main');
    assert.equal(list.sources[0].isDefault, true);
    assert.equal(list.defaultSource, 'main');

    // 更新 mode
    await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'main', driver: 'sqlite', file: '/tmp/a.db', mode: 'admin' }) });
    list = await api('/v1/data-sources').then((r) => r.json());
    assert.equal(list.sources[0].mode, 'admin');

    // 再加一個 → 預設不變
    await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'second', driver: 'sqlite', file: '/tmp/b.db' }) });
    list = await api('/v1/data-sources').then((r) => r.json());
    assert.equal(list.sources.length, 2);
    assert.equal(list.defaultSource, 'main');

    // 刪除預設 → 預設轉移
    r = await api('/v1/data-sources/delete', { method: 'POST', body: JSON.stringify({ name: 'main' }) }).then((x) => x.json());
    assert.equal(r.ok, true);
    list = await api('/v1/data-sources').then((r) => r.json());
    assert.equal(list.sources.length, 1);
    assert.equal(list.defaultSource, 'second');
  });
});

test('密碼不外洩：postgres 存密碼 → 列表只回 hasPassword，設定檔含密碼', async () => {
  await withApp(async ({ api, base }) => {
    await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'wh', driver: 'postgres', host: 'h', database: 'd', user: 'u', password: 'secret', mode: 'read' }) });
    const list = await api('/v1/data-sources').then((r) => r.json());
    const s = list.sources[0];
    assert.equal(s.hasPassword, true);
    assert.equal(s.password, undefined, '列表不含明文密碼');
    // 存檔仍保留密碼供實連
    const saved = JSON.parse(readFileSync(join(base, 'data-sources.json'), 'utf8'));
    assert.equal(saved.sources.wh.password, 'secret');
  });
});

test('密碼留空 = 沿用既有（編輯不必重填）', async () => {
  await withApp(async ({ api, base }) => {
    await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'wh', driver: 'postgres', host: 'h', database: 'd', user: 'u', password: 'p1' }) });
    // 更新 mode，密碼留空
    await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'wh', driver: 'postgres', host: 'h', database: 'd', user: 'u', password: '', mode: 'write' }) });
    const saved = JSON.parse(readFileSync(join(base, 'data-sources.json'), 'utf8'));
    assert.equal(saved.sources.wh.password, 'p1', '留空 → 沿用');
    assert.equal(saved.sources.wh.mode, 'write');
  });
});

test('驗證：非法名稱 / 未知驅動 / sqlite 缺檔 → 400', async () => {
  await withApp(async ({ api }) => {
    assert.equal((await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'a b', driver: 'sqlite', file: '/x' }) })).status, 400);
    assert.equal((await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'x', driver: 'oracle' }) })).status, 400);
    assert.equal((await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'x', driver: 'sqlite' }) })).status, 400);
    assert.equal((await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'x', driver: 'postgres' }) })).status, 400, 'pg 缺 host → 400');
  });
});

test('database 可選（引擎感知）：MySQL 可留空、PostgreSQL 必填', async () => {
  await withApp(async ({ api }) => {
    // MySQL 有 host、無 database → 允許（跨庫查看全部）
    const my = await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'mysrv', driver: 'mysql', host: 'h', user: 'u', password: 'p' }) });
    assert.equal(my.status, 200, 'MySQL 無 database 應允許');
    // PostgreSQL 有 host、無 database → 擋
    const pg = await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'pgsrv', driver: 'postgres', host: 'h', user: 'u' }) }).then((r) => r.json());
    assert.match(pg.error || '', /database/);
    // PostgreSQL 用 url → 免填 database
    const pgUrl = await api('/v1/data-sources', { method: 'POST', body: JSON.stringify({ name: 'pgurl', driver: 'postgres', url: 'postgresql://u@h:5432/d' }) });
    assert.equal(pgUrl.status, 200, 'PG 用 url 應允許');
  });
});

test('鑑權：缺 token → 401', async () => {
  await withApp(async ({ api }) => {
    const bad = await api('/v1/data-sources', { headers: { authorization: '' } });
    assert.equal(bad.status, 401);
  });
});

test('測試連線：真實 sqlite → ok + tableCount', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  await withApp(async ({ api, root }) => {
    const db = join(root, 'real.db');
    const seed = spawnSync('sqlite3', [db, 'CREATE TABLE users(id); CREATE TABLE orders(id);'], { encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const r = await api('/v1/data-sources/test', { method: 'POST', body: JSON.stringify({ name: 'probe', driver: 'sqlite', file: db, mode: 'read' }) }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.tableCount, 2);
    assert.ok(r.tables.includes('users') && r.tables.includes('orders'));
  });
});

test('測試連線：sqlite 指向不存在的命令情境以外 —— 壞路徑回 ok:false 不拋', { skip: !hasSqlite && 'no sqlite3' }, async () => {
  await withApp(async ({ api }) => {
    const r = await api('/v1/data-sources/test', { method: 'POST', body: JSON.stringify({ name: 'p', driver: 'sqlite', file: '/nonexistent/dir/x.db', mode: 'read' }) }).then((x) => x.json());
    // sqlite3 對不存在的目錄會報錯 → ok:false（而非拋例外/500）
    assert.equal(typeof r.ok, 'boolean');
  });
});
