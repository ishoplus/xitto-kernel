// general pack — 通用自主 agent。廣的 system prompt + 檔案/shell/web 工具。
// 搭配 kernel 的 runGoal（目標循環）+ 子 agent + MCP，即為「給目標、自己做到完成」的通用 agent。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execSync } from 'node:child_process';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是通用自主 agent。給你一個目標，你用工具反覆推進直到完成：',
  '- 可讀寫檔案、跑 shell 命令、抓網頁（web_fetch）、派子 agent 做聚焦調查。',
  '- 先想清楚步驟再動手；每步簡述你在做什麼。',
  '- 需要外部資料先 web_fetch 查證，不要憑空編造。',
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
    name: 'bash', label: 'bash', description: '執行 shell 命令', mutating: true, sandboxable: true,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (_id, { command }) => { try { return txt(execSync(command, { cwd, encoding: 'utf8', timeout: 120000 }) || '(no output)'); } catch (e) { return txt({ error: e.message, stdout: e.stdout, stderr: e.stderr }); } },
  };
  const webFetch = {
    name: 'web_fetch', label: '抓網頁', description: '抓取一個 URL 的內容並回傳純文字（HTML 去標籤、截斷）。查線上資料用。', readOnly: true,
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    execute: async (_id, { url }) => {
      try {
        const res = await fetch(url, { headers: { 'user-agent': 'xitto-kernel' }, signal: AbortSignal.timeout(20000) });
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        return txt({ url, status: res.status, text: text || '(空)' });
      } catch (e) { return txt({ error: e?.message || String(e), url }); }
    },
  };

  return {
    name: 'general',
    tools: () => [read, ls, write, edit, bash, webFetch],
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
