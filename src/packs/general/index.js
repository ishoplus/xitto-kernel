// general pack — 通用自主 agent。廣的 system prompt + 檔案/shell/web 工具。
// 搭配 kernel 的 runGoal（目標循環）+ 子 agent + MCP，即為「給目標、自己做到完成」的通用 agent。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';

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
  const readFiles = new Set();
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));

  const read = {
    name: 'read', label: '讀檔', description: '讀取檔案內容', readOnly: true,
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (_id, { path }) => { const p = abs(path); if (!existsSync(p)) return txt({ error: '檔案不存在', path }); readFiles.add(p); return txt(readFileSync(p, 'utf8')); },
  };
  const ls = {
    name: 'ls', label: '列目錄', description: '列出目錄內容', readOnly: true,
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (_id, { path = '.' }) => { const p = abs(path); if (!existsSync(p)) return txt({ error: '目錄不存在', path }); return txt(readdirSync(p).map((n) => n + (statSync(join(p, n)).isDirectory() ? '/' : '')).join('\n')); },
  };
  const write = {
    name: 'write', label: '寫檔', description: '建立或覆寫檔案', mutating: true,
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async (_id, { path, content }) => { const p = abs(path); writeFileSync(p, content ?? '', 'utf8'); readFiles.add(p); return txt({ written: path, bytes: Buffer.byteLength(content ?? '') }); },
  };
  const edit = {
    name: 'edit', label: '編輯', description: '把檔案中的 oldText 換成 newText', mutating: true,
    parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] },
    execute: async (_id, { path, oldText, newText }) => { const p = abs(path); if (!existsSync(p)) return txt({ error: '檔案不存在', path }); const b = readFileSync(p, 'utf8'); if (!b.includes(oldText)) return txt({ error: 'oldText 未找到', path }); writeFileSync(p, b.replace(oldText, newText), 'utf8'); return txt({ edited: path }); },
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
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const stripTags = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

  const webFetch = {
    name: 'web_fetch', label: '抓網頁', description: '抓取一個 URL 的內容並回傳純文字（HTML 去標籤、截斷）。讀某頁全文用。', readOnly: true,
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    execute: async (_id, { url }) => {
      try {
        const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        return txt({ url, status: res.status, text: text || '(空)' });
      } catch (e) { return txt({ error: e?.message || String(e), url }); }
    },
  };

  const webSearch = {
    name: 'web_search', label: '網路搜尋', readOnly: true,
    description: '用關鍵字搜尋網路，回傳前幾筆結果（標題 + URL + 摘要）。先 search 找來源，再用 web_fetch 讀全文。',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute: async (_id, { query }) => {
      try {
        const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
        const html = await res.text();
        const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
        const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
        const decode = (href) => { const u = /uddg=([^&]+)/.exec(href); return u ? decodeURIComponent(u[1]) : href; };
        const results = links.slice(0, 6).map((m, i) => ({ title: stripTags(m[2]), url: decode(m[1]), snippet: snippets[i] || '' }));
        return txt({ query, count: results.length, results });
      } catch (e) { return txt({ error: e?.message || String(e), query }); }
    },
  };

  // 通用 HTTP：串接任何 REST API（GET/POST/PUT/DELETE…，可帶 headers/body）。非唯讀（可能有副作用）→ 走確認。
  const http = {
    name: 'http', label: 'HTTP 請求',
    description: '發 HTTP 請求串接 API：method（預設 GET）、headers、body。回 status + headers + body（截斷）。',
    parameters: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } }, required: ['url'] },
    execute: async (_id, { url, method = 'GET', headers, body }) => {
      try {
        const m = String(method).toUpperCase();
        const res = await fetch(url, { method: m, headers: headers || {}, body: (m === 'GET' || m === 'HEAD') ? undefined : body, signal: AbortSignal.timeout(20000) });
        const text = (await res.text()).slice(0, 8000);
        return txt({ url, method: m, status: res.status, headers: Object.fromEntries(res.headers), body: text });
      } catch (e) { return txt({ error: e?.message || String(e), url }); }
    },
  };

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
    systemPrompt: SYSTEM_PROMPT,
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
