// 共用檔案/shell 工具（read/ls/write/edit/bash）+ read-before-edit 守衛。
// 多個 pack（coding/devops…）共用；read 附行號、edit 唯一性檢查、bash 用 spawnSync 捕捉 stderr。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

/**
 * @param {string} cwd
 * @returns {{ read, ls, write, edit, bash, readBeforeEdit }}
 */
export function createFsTools(cwd) {
  const readFiles = new Set();
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));
  // 寫檔限制在工作目錄內：逃逸 cwd（如 /tmp、/app）回 null。讀檔不限制。
  const within = (p) => { const full = abs(p); const r = relative(cwd, full); return (r === '' || (!r.startsWith('..') && !isAbsolute(r))) ? full : null; };
  const escapeErr = (path) => txt({ error: `只能寫在工作目錄內：${cwd}`, hint: '請用相對路徑（如 report.md）', path });

  const read = {
    name: 'read', label: '讀檔', readOnly: true,
    description: '讀取檔案內容（每行附行號）。大檔可用 offset(起始行,1-based)+limit(行數)。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] },
    execute: async (_id, { path, offset, limit }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      readFiles.add(p);
      const lines = readFileSync(p, 'utf8').split('\n');
      const start = Math.max(0, (offset || 1) - 1);
      const count = limit && limit > 0 ? limit : 2000;
      const numbered = lines.slice(start, start + count).map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n');
      const remain = lines.length - (start + count);
      return txt(numbered + (remain > 0 ? `\n… 還有 ${remain} 行（offset=${start + count + 1}）` : ''));
    },
  };
  const ls = {
    name: 'ls', label: '列目錄', readOnly: true, description: '列出目錄內容',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (_id, { path = '.' }) => { const p = abs(path); if (!existsSync(p)) return txt({ error: '目錄不存在', path }); return txt(readdirSync(p).map((n) => n + (statSync(join(p, n)).isDirectory() ? '/' : '')).join('\n')); },
  };
  const write = {
    name: 'write', label: '寫檔', mutating: true, description: '建立或覆寫檔案',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async (_id, { path, content }) => { const p = within(path); if (!p) return escapeErr(path); writeFileSync(p, content ?? '', 'utf8'); readFiles.add(p); return txt({ written: path, bytes: Buffer.byteLength(content ?? '') }); },
  };
  const edit = {
    name: 'edit', label: '編輯', mutating: true,
    description: '把 oldText 換成 newText。oldText 須唯一（多次出現需 replaceAll）。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldText', 'newText'] },
    execute: async (_id, { path, oldText, newText, replaceAll }) => {
      const p = within(path); if (!p) return escapeErr(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      const before = readFileSync(p, 'utf8');
      const n = before.split(oldText).length - 1;
      if (n === 0) return txt({ error: 'oldText 未找到（先 read 確認）', path });
      if (n > 1 && !replaceAll) return txt({ error: `oldText 出現 ${n} 次，請更精確或設 replaceAll`, path });
      writeFileSync(p, replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText), 'utf8');
      return txt({ edited: path, replaced: replaceAll ? n : 1 });
    },
  };
  const bash = {
    name: 'bash', label: 'bash', mutating: true, sandboxable: true,
    description: '執行 shell 命令（可選 timeout 秒數，預設 120）。長時間/常駐用 bash_bg。',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] },
    execute: async (_id, { command, timeout }) => {
      const ms = Math.min(600, Math.max(1, timeout || 120)) * 1000;
      const r = spawnSync(command, { shell: true, cwd, encoding: 'utf8', timeout: ms, maxBuffer: 16 * 1024 * 1024 });
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      if (r.error) return txt({ error: r.error.message, output });
      if (r.status !== 0) return txt({ error: `命令結束碼 ${r.status}`, output: output || '(no output)' });
      return txt(output || '(no output)');
    },
  };

  // read-before-edit 守衛（給 pack 的 preToolPolicy 用）
  const readBeforeEdit = (ctx) => {
    if ((ctx.name === 'edit' || ctx.name === 'write') && ctx.args?.path) {
      const p = abs(ctx.args.path);
      if (existsSync(p) && !readFiles.has(p)) return { block: true, reason: `請先 read ${ctx.args.path} 再編輯。` };
    }
    return undefined;
  };

  return { read, ls, write, edit, bash, readBeforeEdit };
}
