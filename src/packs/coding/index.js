// coding pack — 參考 DomainPack（對標 xitto-code 的編碼能力）。
// 工具以輕量真實實作示範（read/ls/write/edit 真的動檔案）；bash 走 shell。
// read-before-edit 守衛與 read 工具透過閉包共享 readFiles 狀態，故能真實生效。
// 對應 docs/05-example-packs.md「A. coding pack」。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createBackgroundTools } from '../../kernel/bg.js';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';
import { isDocFile, extractDocText, DOC_EXTENSIONS } from '../shared/doc-extract.js';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是嚴謹的編碼 agent。準則：',
  '- 探索 codebase：用 glob 找檔、grep 搜內容、read 讀檔（附行號）。',
  '- 編輯既有檔案前必先 read 它的當前內容，不基於臆測修改。',
  '- edit 的 oldText 要夠精確且唯一（含足夠上下文）；要全部取代用 replaceAll。',
  '- 多步任務（3 步以上）先用 todo_write 規劃並隨進度更新。',
  '- 長時間/常駐命令（dev server、watch）用 bash_bg 後台執行，再用 bash_output 看輸出。',
  '- 一次做一件事，改動後說明你做了什麼、如何驗證。',
  '- 破壞性操作先確認。',
  '- 要提交時：先 git_diff 看變更，再用 git_commit 寫一則簡潔、說明「為何」的 commit 訊息。',
].join('\n');

/**
 * 建立一個帶獨立 readFiles 狀態的 coding pack。
 * @param {{ cwd?: string }} [opts]
 * @returns {import('../../types.js').DomainPack}
 */
export function createCodingPack({ cwd = process.cwd() } = {}) {
  const readFiles = new Set(); // 已 read 過的絕對路徑（read 工具寫入、read-before-edit 守衛讀取）
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));
  // 寫檔限制在工作目錄內：逃逸 cwd（如 /tmp、/app）回 null。讀檔不限制。
  const within = (p) => { const full = abs(p); const r = relative(cwd, full); return (r === '' || (!r.startsWith('..') && !isAbsolute(r))) ? full : null; };
  const escapeErr = (path) => txt({ error: `只能寫在工作目錄內：${cwd}`, hint: '請用相對路徑（如 report.md）', path });
  const bg = createBackgroundTools(cwd); // bash_bg / bash_output / bash_kill

  const readTool = {
    name: 'read', label: '讀檔', readOnly: true,
    description: `讀取檔案內容（每行附行號，方便對照與編輯）。大檔可用 offset(起始行,1-based)+limit(行數) 讀一段。也能讀 Word/Excel/PPT/PDF 等文件（${DOC_EXTENSIONS.join(' ')}），自動萃取成文字。`,
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] },
    execute: async (_id, { path, offset, limit }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      readFiles.add(p);
      let content;
      if (isDocFile(p)) {                                      // Word/Excel/PPT/ODF/RTF/PDF → 萃取文字
        try { content = extractDocText(p); }
        catch (e) { return txt({ error: '文件解析失敗', detail: e.message, path }); }
      } else content = readFileSync(p, 'utf8');
      const lines = content.split('\n');
      const start = Math.max(0, (offset || 1) - 1);
      const count = limit && limit > 0 ? limit : 2000;
      const slice = lines.slice(start, start + count);
      const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n');
      const remain = lines.length - (start + count);
      return txt(numbered + (remain > 0 ? `\n… 還有 ${remain} 行（用 offset=${start + count + 1} 繼續）` : ''));
    },
  };

  const lsTool = {
    name: 'ls', label: '列目錄', description: '列出目錄內容', readOnly: true,
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (_id, { path = '.' }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '目錄不存在', path });
      return txt(readdirSync(p).map((n) => n + (statSync(join(p, n)).isDirectory() ? '/' : '')).join('\n'));
    },
  };

  const writeTool = {
    name: 'write', label: '寫檔', description: '建立或覆寫檔案', mutating: true,
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async (_id, { path, content }) => {
      const p = within(path); if (!p) return escapeErr(path);
      writeFileSync(p, content ?? '', 'utf8');
      readFiles.add(p); // 寫過即視為已知內容
      return txt({ written: path, bytes: Buffer.byteLength(content ?? '') });
    },
  };

  const editTool = {
    name: 'edit', label: '編輯', mutating: true,
    description: '把檔案中的 oldText 換成 newText。oldText 必須唯一（出現多次會失敗，請加上下文；或設 replaceAll:true 全部取代）。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldText', 'newText'] },
    execute: async (_id, { path, oldText, newText, replaceAll }) => {
      const p = within(path); if (!p) return escapeErr(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      const before = readFileSync(p, 'utf8');
      const occurrences = before.split(oldText).length - 1;
      if (occurrences === 0) return txt({ error: 'oldText 未找到（請先 read 確認當前內容）', path });
      if (occurrences > 1 && !replaceAll) return txt({ error: `oldText 出現 ${occurrences} 次，請提供更精確、唯一的 oldText（含上下文），或設 replaceAll:true`, path });
      const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
      writeFileSync(p, after, 'utf8');
      return txt({ edited: path, replaced: replaceAll ? occurrences : 1 });
    },
  };

  const bashTool = {
    name: 'bash', label: 'bash', description: '執行 shell 命令（可選 timeout 秒數，預設 120）。長時間/常駐的命令請改用 bash_bg。', mutating: true, sandboxable: true,
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] },
    execute: async (_id, { command, timeout }) => {
      const ms = Math.min(600, Math.max(1, timeout || 120)) * 1000;
      // spawnSync 同時捕捉 stdout+stderr（不漏到終端，agent 也看得到錯誤輸出）
      const r = spawnSync(command, { shell: true, cwd, encoding: 'utf8', timeout: ms, maxBuffer: 16 * 1024 * 1024 });
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      if (r.error) return txt({ error: r.error.message, output });
      if (r.status !== 0) return txt({ error: `命令結束碼 ${r.status}`, output: output || '(no output)' });
      return txt(output || '(no output)');
    },
  };

  // ── codebase 導航：grep / glob（共用模組）──
  const grepTool = createGrepTool(cwd);
  const globTool = createGlobTool(cwd);

  const webFetch = {
    name: 'web_fetch', label: '抓網頁', readOnly: true,
    description: '抓取一個 URL 的內容並回傳純文字（HTML 去標籤、截斷）。查線上文件/API 用。',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    execute: async (_id, { url }) => {
      try {
        const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 xitto-kernel' }, signal: AbortSignal.timeout(20000) });
        const html = await res.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        return txt({ url, status: res.status, text: text || '(空)' });
      } catch (e) { return txt({ error: e?.message || String(e), url }); }
    },
  };

  // ── git 工具（編碼領域）：kernel 不認識 git，這些是 coding pack 提供的領域能力 ──
  const git = (a) => { try { return execSync(`git ${a}`, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); } catch { return null; } };
  const isRepo = () => { try { execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'ignore' }); return true; } catch { return false; } };

  const gitStatus = {
    name: 'git_status', label: 'git 狀態', readOnly: true, description: '顯示目前分支與工作區變更（git status）',
    parameters: { type: 'object', properties: {} },
    execute: async () => { if (!isRepo()) return txt({ error: '非 git 倉庫' }); return txt({ branch: (git('rev-parse --abbrev-ref HEAD') || '').trim(), changes: (git('status --short') || '').trim() || '(乾淨)' }); },
  };
  const gitDiff = {
    name: 'git_diff', label: 'git diff', readOnly: true, description: '顯示未提交變更的 diff（staged=true 看已暫存）',
    parameters: { type: 'object', properties: { staged: { type: 'boolean' } } },
    execute: async (_id, { staged } = {}) => { if (!isRepo()) return txt({ error: '非 git 倉庫' }); return txt((git(`diff ${staged ? '--cached' : ''}`) || '').trim() || '(無變更)'); },
  };
  const gitLog = {
    name: 'git_log', label: 'git log', readOnly: true, description: '最近的提交記錄',
    parameters: { type: 'object', properties: { n: { type: 'number' } } },
    execute: async (_id, { n = 10 } = {}) => { if (!isRepo()) return txt({ error: '非 git 倉庫' }); return txt(git(`log --oneline -${Math.min(50, Math.max(1, n || 10))}`) || '(無提交)'); },
  };
  const gitCommit = {
    name: 'git_commit', label: 'git commit', mutating: true,
    description: '提交變更。message 由你依 git_diff 撰寫（簡潔說明做了什麼與為何）；all=true 會先 git add -A。',
    parameters: { type: 'object', properties: { message: { type: 'string' }, all: { type: 'boolean' } }, required: ['message'] },
    execute: async (_id, { message, all }) => {
      if (!isRepo()) return txt({ error: '非 git 倉庫' });
      if (all) git('add -A');
      try { return txt((execSync(`git commit -m ${JSON.stringify(String(message))}`, { cwd, encoding: 'utf8' }) || '').trim()); }
      catch (e) { return txt({ error: (e.stdout || e.message || '').toString().trim() }); }
    },
  };

  return {
    name: 'coding',
    tools: () => [readTool, lsTool, globTool, grepTool, writeTool, editTool, bashTool, ...bg.tools, webFetch, gitStatus, gitDiff, gitLog, gitCommit],
    systemPrompt: SYSTEM_PROMPT,
    contextFiles: ['CLAUDE.md', 'AGENTS.md', 'XITTO.md', '.xitto-code.md'],
    // mutatingTools 省略 → kernel 從工具 metadata 推導（write/edit/bash）
    verify: {
      shouldRun: (ctx) => ctx.turnModified,
      run: async () => {
        const cmd = detectVerifyCmd(cwd);
        if (!cmd) return { ok: true };
        try { execSync(cmd, { cwd, stdio: 'pipe' }); return { ok: true }; }
        catch (e) { return { ok: false, output: String(e.stdout || e.message).slice(0, 4000) }; }
      },
      maxRounds: 2,
    },
    preToolPolicy: {
      // read-before-edit：編輯已存在但未讀過的檔 → 擋下要求先 read
      check: (ctx) => {
        if ((ctx.name === 'edit' || ctx.name === 'write') && ctx.args?.path) {
          const p = abs(ctx.args.path);
          if (existsSync(p) && !readFiles.has(p)) {
            return { block: true, reason: `請先用 read 讀取 ${ctx.args.path} 的當前內容，再進行編輯（read-before-edit）。` };
          }
        }
        return undefined;
      },
    },
    permissionPolicy: { sandbox: { enabled: false }, defaultMode: 'default' },
  };
}

// 偵測專案的型別/lint 驗證指令（簡化版；真實版見 xitto-code util.detectVerifyCmd）
function detectVerifyCmd(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    if (pkg.scripts?.typecheck) return 'npm run typecheck';
    if (pkg.scripts?.lint) return 'npm run lint';
  } catch { /* 無 package.json → 無驗證指令 */ }
  return null;
}

export const codingPack = createCodingPack();
export { relative }; // 供示範引用
