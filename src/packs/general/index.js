// general pack — 通用自主 agent。廣的 system prompt + 檔案/shell/web 工具。
// 搭配 kernel 的 runGoal（目標循環）+ 子 agent + MCP，即為「給目標、自己做到完成」的通用 agent。
import { withBaseRules } from '../shared/prompt.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, extname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';
import { markRead, writeAtomic } from '../shared/safe-write.js';
import { createWebFetchTool, createWebSearchTool, createHttpTool } from '../shared/web-tools.js';
import { isDocFile, extractDocText, DOC_EXTENSIONS } from '../shared/doc-extract.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是通用自主 agent。給你一個目標，你用工具反覆推進直到完成：',
  '- 可讀寫檔案、grep/glob 找東西、跑 shell、搜尋網路(web_search)、抓網頁(web_fetch)、',
  '  串接 API(http)、讀圖(read_image)、派子 agent、用待辦(todo_write)規劃多步任務。',
  '- 先想清楚步驟再動手；每步簡述你在做什麼。',
  '- 需要外部資料：先 web_search 找來源，再 web_fetch 讀全文；串 API 用 http。不要憑空編造。',
  '- 還缺的能力（瀏覽器點擊、特定服務）可由使用者掛 MCP server 補上。',
  '- 編輯既有檔案前先 read；破壞性/對外操作前確認。',
  '- 完成後明確說「已完成」並總結結果與如何驗證。',
].join('\n');

export function createGeneralPack({ cwd = process.cwd() } = {}) {
  const readFiles = new Map(); // path → 讀取當下 mtimeMs（供併發陳舊防護）；has(p) 仍表「本回合讀過」
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));
  // 寫檔限制在工作目錄內：回解析後路徑,逃逸 cwd（如 /tmp、/app）回 null。讀檔不限制。
  const within = (p) => { const full = abs(p); const r = relative(cwd, full); return (r === '' || (!r.startsWith('..') && !isAbsolute(r))) ? full : null; };
  const escapeErr = (path) => txt({ error: `只能寫在工作目錄內：${cwd}`, hint: '請用相對路徑（如 report.md），不要寫到工作區之外', path });

  const read = {
    name: 'read', label: '讀檔', description: `讀取檔案內容（也能讀 Word/Excel/PPT/PDF 等文件 ${DOC_EXTENSIONS.join(' ')}，自動萃取成文字）`, readOnly: true,
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (_id, { path }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      markRead(readFiles, p);
      if (isDocFile(p)) { try { return txt(extractDocText(p)); } catch (e) { return txt({ error: '文件解析失敗', detail: e.message, path }); } }
      return txt(readFileSync(p, 'utf8'));
    },
  };
  const ls = {
    name: 'ls', label: '列目錄', description: '列出目錄內容', readOnly: true,
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (_id, { path = '.' }) => { const p = abs(path); if (!existsSync(p)) return txt({ error: '目錄不存在', path }); return txt(readdirSync(p).map((n) => n + (statSync(join(p, n)).isDirectory() ? '/' : '')).join('\n')); },
  };
  const write = {
    name: 'write', label: '寫檔', description: '建立或覆寫檔案', mutating: true,
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async (_id, { path, content }) => {
      const p = within(path); if (!p) return escapeErr(path);
      if (writeAtomic(readFiles, p, content ?? '', true).stale) return txt({ error: `${path} 在你 read 之後被改動（避免覆寫他人更新），請重新 read 再寫`, path });
      return txt({ written: path, bytes: Buffer.byteLength(content ?? '') });
    },
  };
  const edit = {
    name: 'edit', label: '編輯', description: '把檔案中的 oldText 換成 newText', mutating: true,
    parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] },
    execute: async (_id, { path, oldText, newText }) => { const p = within(path); if (!p) return escapeErr(path); if (!existsSync(p)) return txt({ error: '檔案不存在', path }); const b = readFileSync(p, 'utf8'); if (!b.includes(oldText)) return txt({ error: 'oldText 未找到', path }); writeAtomic(readFiles, p, b.replace(oldText, newText)); return txt({ edited: path }); },
  };
  const bash = {
    name: 'bash', label: 'bash', description: '執行 shell 命令（可選 timeout 秒數，預設 120）', mutating: true, sandboxable: true,
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
  const webFetch = createWebFetchTool();
  const webSearch = createWebSearchTool();
  const http = createHttpTool();

  // 多模態：讀圖交給模型「看」（需模型支援影像輸入）
  const readImage = {
    name: 'read_image', label: '讀圖', readOnly: true,
    description: '讀取一張圖片（png/jpg/gif/webp）交給模型分析（截圖/設計稿/圖表）。需模型支援影像輸入。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (_id, { path }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      const mimeType = MIME[extname(p).toLowerCase()];
      if (!mimeType) return txt({ error: '不支援的格式（png/jpg/gif/webp）', path });
      try { return { content: [{ type: 'image', data: readFileSync(p).toString('base64'), mimeType }] }; }
      catch (e) { return txt({ error: e.message }); }
    },
  };

  const grepTool = createGrepTool(cwd);
  const globTool = createGlobTool(cwd);

  return {
    name: 'general',
    tools: () => [read, ls, globTool, grepTool, write, edit, bash, webSearch, webFetch, http, readImage],
    systemPrompt: withBaseRules(SYSTEM_PROMPT),
    contextFiles: ['AGENTS.md', 'GENERAL.md'],
    preToolPolicy: {
      check: (ctx) => {
        if ((ctx.name === 'edit' || ctx.name === 'write') && ctx.args?.path) {
          const p = abs(ctx.args.path);
          if (existsSync(p) && !readFiles.has(p)) return { block: true, reason: `請先 read ${ctx.args.path} 再編輯。` };
        }
        return undefined;
      },
    },
    permissionPolicy: { defaultMode: 'default' },
  };
}

export const generalPack = createGeneralPack();
