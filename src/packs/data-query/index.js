// data-query pack — 多源真實資料查詢 agent（sqlite / postgres / mysql）。
// pg/mysql 原生優先（mysql2/pg 可選依賴，免裝資料庫 CLI）→ 未裝則回落 CLI；sqlite 走 sqlite3 CLI（見 shared/db.js）。
// 三道守衛（皆在守衛鏈第 3 格，agent 無法繞過）：
//   1. schema-before-query：某源沒先看過結構就下 SQL → 擋（對照 read-before-edit）。
//   2. 讀寫分流：sql_query 只准唯讀 SQL；寫入型走 sql_exec。
//   3. per-source mode：能力邊界寫在「人類配置」（sources.json）——read 只讀 / write 可寫不可破壞 /
//      admin 全開。破壞性 SQL（DROP/TRUNCATE/ALTER/無 WHERE 的 DELETE/UPDATE…）由分類器判級，
//      這是真正的硬閘（server 端 confirm 恆放行，故安全不能依賴確認彈窗，要靠這條配置邊界）。
// 對應 docs/05-example-packs.md「B. data-query pack」。
import { withBaseRules } from '../shared/prompt.js';
import { createDriver, loadSources, classifySql, toCsv } from '../shared/db.js';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是資料分析 agent，對一或多個資料庫工作。準則：',
  '- 先用 list_sources 看有哪些資料源（各自的驅動與權限級別）。多源時每個工具都可帶 source 指定要對哪個庫。',
  '- 對某源下查詢前，先用 list_tables / describe_table 了解該源結構（沒看過會被擋）。',
  '- 唯讀查詢用 sql_query；寫入（INSERT/UPDATE/DELETE/建表）用 sql_exec。',
  '- 資料源的權限級別由設定決定：read=唯讀、write=可寫但不可破壞、admin=全開。被擋時別硬試，如實回報是權限級別限制。',
  '- 破壞性 SQL（DROP/TRUNCATE/無 WHERE 的 DELETE 等）只有 admin 級的源能跑；即便如此也先向使用者確認。',
  '- 回答問題時根據真實查詢結果，不要臆測數字。',
].join('\n');

// mode → 允許的最高風險級別
const MODE_MAX = { read: 'read', write: 'write', admin: 'destructive' };
const LEVEL_ORDER = { read: 0, write: 1, destructive: 2 };

export function createDataQueryPack({ cwd = process.cwd(), db, sources, sourcesPath } = {}) {
  const { sources: srcMap, defaultSource, error: cfgError, warnings } =
    loadSources({ cwd, db, sources, configPath: sourcesPath });
  const drivers = new Map();       // name → Promise<driver>（懶建、快取；createDriver 為 async）
  const schemaSeen = new Set();    // name → 是否已看過該源結構
  const driverFor = (name) => {
    if (!drivers.has(name)) drivers.set(name, createDriver(srcMap.get(name)));
    return drivers.get(name);      // 回 Promise，呼叫端 await
  };
  // 解析 source 參數 → { name, src } 或 { error }
  const resolve = (name) => {
    const key = name || defaultSource;
    if (!srcMap.has(key)) return { error: `未知資料源「${key}」，可用：${[...srcMap.keys()].join(', ')}` };
    return { name: key, src: srcMap.get(key) };
  };
  const sourceParam = { source: { type: 'string', description: srcMap.size > 1 ? `資料源名稱（可用：${[...srcMap.keys()].join(', ')}；預設 ${defaultSource}）` : '資料源名稱（可省略）' } };

  const listSources = {
    name: 'list_sources', label: '資料源', readOnly: true,
    description: '列出所有已設定的資料源（名稱、驅動、權限級別 read/write/admin、是否預設）。',
    parameters: { type: 'object', properties: {} },
    execute: async () => txt({
      sources: [...srcMap.values()].map((s) => ({ name: s.name, driver: s.driver, mode: s.mode, default: s.name === defaultSource })),
      ...(warnings?.length ? { warnings } : {}), ...(cfgError ? { note: cfgError } : {}),
    }),
  };

  const listTables = {
    name: 'list_tables', label: '列表', readOnly: true, description: '列出某資料源的所有資料表。',
    parameters: { type: 'object', properties: { ...sourceParam } },
    execute: async (_id, { source } = {}) => {
      const { name, src, error } = resolve(source); if (error) return txt({ error });
      schemaSeen.add(name);
      const r = await (await driverFor(name)).listTables();
      return txt(r.error ? { source: name, error: r.error } : { source: name, driver: src.driver, mode: src.mode, tables: r.tables });
    },
  };

  const describeTable = {
    name: 'describe_table', label: '表結構', readOnly: true, description: '看某資料源某表的欄位定義。',
    parameters: { type: 'object', properties: { table: { type: 'string' }, ...sourceParam }, required: ['table'] },
    execute: async (_id, { table, source } = {}) => {
      const { name, error } = resolve(source); if (error) return txt({ error });
      schemaSeen.add(name);
      const r = await (await driverFor(name)).describeTable(table);
      return txt(r.error ? { source: name, error: r.error } : { source: name, schema: r.schema });
    },
  };

  const sqlQuery = {
    name: 'sql_query', label: '查詢', readOnly: true,
    description: '執行唯讀 SQL 查詢（SELECT/WITH/PRAGMA…），回 CSV（含表頭）。單條無 LIMIT 的 SELECT 會自動補上限。',
    parameters: { type: 'object', properties: { sql: { type: 'string' }, ...sourceParam }, required: ['sql'] },
    execute: async (_id, { sql, source } = {}) => {
      const { name, error } = resolve(source); if (error) return txt({ error });
      const r = await (await driverFor(name)).query(sql);
      if (r.error) return txt({ source: name, error: r.error });
      const csv = toCsv(r);
      const note = r.truncated ? `（已截斷：僅顯示前 ${r.rows.length} 列，實際更多，請加 WHERE/LIMIT 收斂）` : '';
      return txt(csv ? csv + (note ? '\n' + note : '') : '(空結果)');
    },
  };

  const sqlExec = {
    name: 'sql_exec', label: '寫入', mutating: true,
    description: '執行寫入型 SQL（INSERT/UPDATE/DELETE/CREATE…）。是否放行由該資料源的權限級別決定。',
    parameters: { type: 'object', properties: { sql: { type: 'string' }, ...sourceParam }, required: ['sql'] },
    execute: async (_id, { sql, source } = {}) => {
      const { name, error } = resolve(source); if (error) return txt({ error });
      const r = await (await driverFor(name)).exec(sql);
      if (r.error) return txt({ source: name, error: r.error });
      return txt({ source: name, ok: true, out: r.out || '' });
    },
  };

  return {
    name: 'data-query',
    tools: () => [listSources, listTables, describeTable, sqlQuery, sqlExec],
    systemPrompt: withBaseRules(SYSTEM_PROMPT),
    contextFiles: ['SCHEMA.md', 'METRICS.md'],
    // 所有 SQL 政策收斂在此（守衛鏈第 3 格，agent 無法繞過）：源存在性 → schema-before-query → 讀寫分流 → per-source mode。
    preToolPolicy: {
      check: (ctx) => {
        const isQuery = ctx.name === 'sql_query', isExec = ctx.name === 'sql_exec';
        if (!isQuery && !isExec) return undefined;
        const { name, src, error } = resolve(ctx.args?.source);
        if (error) return { block: true, reason: error };
        if (!schemaSeen.has(name)) {
          return { block: true, reason: `資料源「${name}」尚未看過結構，請先用 list_tables / describe_table（source: "${name}"）了解結構，再下 SQL。` };
        }
        const { level } = classifySql(ctx.args?.sql || '');
        if (level === 'empty') return { block: true, reason: 'SQL 不可為空。' };
        if (isQuery && level !== 'read') {
          return { block: true, reason: '這是寫入型 SQL，sql_query 僅限唯讀（SELECT/WITH/PRAGMA…），請改用 sql_exec。' };
        }
        if (isExec) {
          const allowed = MODE_MAX[src.mode] || 'read';
          if (LEVEL_ORDER[level] > LEVEL_ORDER[allowed]) {
            const why = src.mode === 'read'
              ? `資料源「${name}」為唯讀（read），不接受寫入。`
              : `資料源「${name}」權限級別為 ${src.mode}，不允許${level === 'destructive' ? '破壞性（DROP/TRUNCATE/無 WHERE 的 DELETE/ALTER…）' : '寫入'}操作。`;
            return { block: true, reason: `${why} 若確需放寬，請人類在 .xitto-kernel/data-query/sources.json 把該源 mode 調為 ${level === 'destructive' ? 'admin' : 'write'}（agent 無法自行變更）。` };
          }
        }
        return undefined;
      },
    },
    permissionPolicy: { defaultMode: 'default' },
  };
}

export const dataQueryPack = createDataQueryPack();
