// data-query pack — 第二個範例領域，用來證明「同介面、kernel 零改動」。
// 工具為示意 stub（回傳假資料），重點是六個插槽用法與 coding 完全一樣，只是內容換了。
// 對照：schema-before-query 之於資料查詢 == read-before-edit 之於編碼（同 preToolPolicy 插槽）。
// 對應 docs/05-example-packs.md「B. data-query pack」。

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是資料分析 agent。準則：',
  '- 下查詢前先用 list_tables / describe_table 了解結構。',
  '- 破壞性 SQL（DROP/TRUNCATE/DELETE 無 WHERE）一律先確認。',
].join('\n');

/**
 * @param {{ schema?: Record<string,string[]> }} [opts]
 * @returns {import('../../types.js').DomainPack}
 */
export function createDataQueryPack({ schema = { orders: ['id', 'amount', 'user_id'], users: ['id', 'name'] } } = {}) {
  let schemaLoaded = false; // describe/list 後設為 true，schema-before-query 守衛據此放行

  const listTables = {
    name: 'list_tables', label: '列表', description: '列出所有資料表', readOnly: true,
    parameters: { type: 'object', properties: {} },
    execute: async () => { schemaLoaded = true; return txt(Object.keys(schema)); },
  };
  const describeTable = {
    name: 'describe_table', label: '表結構', description: '看某表欄位', readOnly: true,
    parameters: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    execute: async (_id, { table }) => { schemaLoaded = true; return txt(schema[table] || { error: '無此表' }); },
  };
  const sqlQuery = {
    name: 'sql_query', label: '查詢', description: '執行唯讀 SQL 查詢', readOnly: true,
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    execute: async (_id, { sql }) => txt({ note: '（示意）查詢結果', sql, rows: [] }),
  };
  const sqlExec = {
    name: 'sql_exec', label: '寫入', description: '執行寫入型 SQL（INSERT/UPDATE/DELETE）', mutating: true,
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    execute: async (_id, { sql }) => txt({ note: '（示意）已執行', sql }),
  };
  const chartRender = {
    name: 'chart_render', label: '畫圖', description: '把查詢結果渲染成圖表', readOnly: true,
    parameters: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] },
    execute: async (_id, { spec }) => txt({ note: '（示意）已渲染', spec }),
  };

  return {
    name: 'data-query',
    tools: () => [listTables, describeTable, sqlQuery, sqlExec, chartRender],
    systemPrompt: SYSTEM_PROMPT,
    contextFiles: ['SCHEMA.md', 'METRICS.md'],
    // sql_query 唯讀、sql_exec 才 mutating → 從 metadata 自動推導 mutatingTools=['sql_exec']
    preToolPolicy: {
      // schema-before-query：沒先看過 schema 就下查詢 → 擋
      check: (ctx) => {
        if ((ctx.name === 'sql_query' || ctx.name === 'sql_exec') && !schemaLoaded) {
          return { block: true, reason: '請先用 list_tables / describe_table 了解結構，再下 SQL。' };
        }
        return undefined;
      },
    },
    permissionPolicy: { deny: ['bash:DROP', 'bash:TRUNCATE'], defaultMode: 'default' },
    // verify 省略 → 查詢無「自我驗收」概念
  };
}

export const dataQueryPack = createDataQueryPack();
