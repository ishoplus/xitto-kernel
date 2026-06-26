// 跨 session 持久記憶 — kernel 內建能力（任何 pack 都自動獲得 memory_save / memory_list）。
// 存成 markdown 一行一條，啟動時載入注入 system prompt。對標 xitto-code memory.js，但領域無關。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

/**
 * @param {string} file  記憶檔路徑（如 <cwd>/.xitto-kernel/<pack>/memory.md）
 */
export function createMemory(file) {
  const readLines = () => (existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean)
    : []);

  const load = () => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
  const list = () => readLines();
  const save = (value) => {
    const v = String(value || '').trim();
    if (!v) return { error: 'value 不可為空' };
    const lines = readLines();
    if (lines.includes(v)) return { skipped: true };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.concat(v).map((l) => `- ${l}`).join('\n') + '\n');
    return { saved: v };
  };

  // memory_save/list 只動 kernel 自己的記憶檔（agent 簿記），標 readOnly → 守衛鏈自動放行
  const tools = [
    {
      name: 'memory_save', label: '存記憶', readOnly: true,
      description: '把值得跨 session 記住的事實存起來（使用者偏好、建置/測試指令、踩過的坑、決策）。一句、自給自足。',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      execute: async (_id, { value }) => txt(save(value)),
    },
    {
      name: 'memory_list', label: '讀記憶', readOnly: true,
      description: '列出已記住的事實（回憶過往偏好/決策時用）。',
      parameters: { type: 'object', properties: {} },
      execute: async () => txt({ memories: list() }),
    },
  ];

  return { load, list, save, tools };
}
