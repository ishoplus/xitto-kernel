// 不靠 LLM 的端到端示範：同一個 kernel 跑兩個領域，守衛真實生效。
// 跑法：npm run demo
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';
import { createDataQueryPack } from '../src/packs/data-query/index.js';

const line = (s = '') => console.log(s);
const show = (label, r) => line(`  ${r.blocked ? '⛔ 擋下' : '✅ 放行'} ${label}` + (r.blocked ? `\n      → ${r.reason}` : ''));

line('\n=== xitto-kernel 示範：同一個 kernel，兩個領域 ===\n');

// ── 領域一：coding ──
const dir = mkdtempSync(join(tmpdir(), 'demo-coding-'));
writeFileSync(join(dir, 'a.txt'), 'hello world');
const coding = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });

line('【coding pack】');
line('  工具：' + coding.registry.names().join(', '));
line('  mutatingTools（從 metadata 推導）：' + [...coding.mutatingTools].join(', '));
line('  唯讀（自動放行）：' + coding.registry.readOnlyNames().join(', '));
line('  read-before-edit 守衛：');
show('未讀就 edit a.txt', await coding.runTool('edit', { path: 'a.txt', oldText: 'hello', newText: 'hi' }));
await coding.runTool('read', { path: 'a.txt' });
show('先 read 再 edit a.txt', await coding.runTool('edit', { path: 'a.txt', oldText: 'hello', newText: 'hi' }));
rmSync(dir, { recursive: true, force: true });

// ── 領域二：data-query（kernel 一行未改）──
const data = createKernel(createDataQueryPack());
line('\n【data-query pack】（同一個 createKernel，零改動）');
line('  工具：' + data.registry.names().join(', '));
line('  mutatingTools（只 sql_exec 是 mutating）：' + [...data.mutatingTools].join(', '));
line('  schema-before-query 守衛：');
show('未看 schema 先 sql_query', await data.runTool('sql_query', { sql: 'SELECT 1' }));
await data.runTool('list_tables', {});
show('先 list_tables 再 sql_query', await data.runTool('sql_query', { sql: 'SELECT 1' }));

line('\n=== 結論：六個插槽吸收領域差異，kernel 不認識「檔案」或「SQL」 ===\n');
