// data-query pack — 真實資料查詢 agent（用 sqlite3 CLI，零依賴）。
// 工具對一個 SQLite .db 跑真實 SQL；schema-before-query 守衛（對照 read-before-edit）。
// 對應 docs/05-example-packs.md「B. data-query pack」。
import { withBaseRules } from '../shared/prompt.js';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

// 用 sqlite3 CLI 跑 SQL（sql 以 argv 傳入，非 shell 內插 → 無 shell 注入）
function sqlite(dbPath, sql, opts = []) {
  const r = spawnSync('sqlite3', [...opts, dbPath, sql], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { error: r.error.code === 'ENOENT' ? '找不到 sqlite3 命令（請先安裝）' : r.error.message };
  if (r.status !== 0) return { error: (r.stderr || '').trim() || `exit ${r.status}` };
  return { out: (r.stdout || '').trim() };
}

const SYSTEM_PROMPT = [
  '你是資料分析 agent，對一個 SQLite 資料庫工作。準則：',
  '- 下查詢前先用 list_tables / describe_table 了解結構。',
  '- 唯讀查詢用 sql_query；寫入（INSERT/UPDATE/DELETE/建表）用 sql_exec。',
  '- 破壞性 SQL（DROP/TRUNCATE/無 WHERE 的 DELETE）先確認。',
  '- 回答問題時根據真實查詢結果，不要臆測數字。',
].join('\n');

export function createDataQueryPack({ cwd = process.cwd(), db } = {}) {
  const dbPath = db ? (isAbsolute(db) ? db : join(cwd, db)) : join(cwd, 'data.db');
  let schemaSeen = false;

  const listTables = {
    name: 'list_tables', label: '列表', readOnly: true, description: '列出資料庫所有資料表',
    parameters: { type: 'object', properties: {} },
    execute: async () => { schemaSeen = true; const r = sqlite(dbPath, '.tables'); return txt(r.error ? { error: r.error } : { tables: (r.out || '').split(/\s+/).filter(Boolean) }); },
  };
  const describeTable = {
    name: 'describe_table', label: '表結構', readOnly: true, description: '看某表的欄位定義（CREATE 語句）',
    parameters: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    execute: async (_id, { table }) => { schemaSeen = true; const r = sqlite(dbPath, `.schema ${table}`); return txt(r.error ? { error: r.error } : (r.out || '(無此表)')); },
  };
  const sqlQuery = {
    name: 'sql_query', label: '查詢', readOnly: true, description: '執行唯讀 SQL 查詢（SELECT/WITH/PRAGMA），回 CSV（含表頭）。',
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    execute: async (_id, { sql }) => {
      if (/\b(insert|update|delete|drop|create|alter|replace)\b/i.test(sql)) return txt({ error: '這是寫入型 SQL，請改用 sql_exec' });
      const r = sqlite(dbPath, sql, ['-header', '-csv']);
      return txt(r.error ? { error: r.error } : (r.out || '(空結果)'));
    },
  };
  const sqlExec = {
    name: 'sql_exec', label: '寫入', mutating: true, description: '執行寫入型 SQL（INSERT/UPDATE/DELETE/CREATE/ALTER）。',
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    execute: async (_id, { sql }) => { const r = sqlite(dbPath, sql); return txt(r.error ? { error: r.error } : { ok: true, out: r.out || '' }); },
  };

  return {
    name: 'data-query',
    tools: () => [listTables, describeTable, sqlQuery, sqlExec],
    systemPrompt: withBaseRules(SYSTEM_PROMPT),
    contextFiles: ['SCHEMA.md', 'METRICS.md'],
    // 只有 sql_exec 是 mutating → kernel 從 metadata 推導
    preToolPolicy: {
      // schema-before-query：沒先看過結構就下 SQL → 擋（對照 read-before-edit）
      check: (ctx) => {
        if ((ctx.name === 'sql_query' || ctx.name === 'sql_exec') && !schemaSeen) {
          return { block: true, reason: '請先用 list_tables / describe_table 了解結構，再下 SQL。' };
        }
        return undefined;
      },
    },
    permissionPolicy: { deny: ['bash:DROP', 'bash:TRUNCATE'], defaultMode: 'default' },
  };
}

export const dataQueryPack = createDataQueryPack();
