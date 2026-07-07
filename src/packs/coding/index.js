// coding pack — 參考 DomainPack（對標 xitto-code 的編碼能力）。
// 工具以輕量真實實作示範（read/ls/write/edit 真的動檔案）；bash 走 shell。
// read-before-edit 守衛與 read 工具透過閉包共享 readFiles 狀態，故能真實生效。
// 對應 docs/05-example-packs.md「A. coding pack」。
import { withBaseRules } from '../shared/prompt.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createBackgroundTools } from '../../kernel/bg.js';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';
import { markRead, writeAtomic } from '../shared/safe-write.js';
import { isDocFile, extractDocText, DOC_EXTENSIONS } from '../shared/doc-extract.js';
import { scanCode, sortFindings } from '../shared/security-scan.js';
import { scanQuality, langOf } from '../shared/code-quality.js';
import { lspDiagnostics, lspDefinition, lspHover, lspSymbols, serverFor, hasCommand } from '../shared/lsp.js';

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
  const readFiles = new Map(); // path → 讀取當下 mtimeMs（read 工具寫入、read-before-edit 守衛用 has()、併發陳舊防護用 mtime）
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
      let content;
      if (isDocFile(p)) {                                      // Word/Excel/PPT/ODF/RTF/PDF → 萃取文字
        try { content = extractDocText(p); }
        catch (e) { return txt({ error: '文件解析失敗', detail: e.message, path }); }
      } else content = readFileSync(p, 'utf8');
      markRead(readFiles, p);
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
      // 併發陳舊防護：本回合讀過此檔、落地前已被別條 lane/外部改動 → 擋，避免整檔覆寫蓋掉他人更新。
      if (writeAtomic(readFiles, p, content ?? '', true).stale) return txt({ error: `${path} 在你 read 之後被改動（避免覆寫他人更新），請重新 read 再寫`, path });
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
      writeAtomic(readFiles, p, after); // edit 已重讀當前內容再套 oldText → 只需原子落地，不做陳舊誤擋
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

  // 安全審查（移植自 CC security-review）：對「當前變更」的程式碼檔做靜態高風險樣式檢查。
  const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|java|kt|php|cs|c|cc|cpp|h|hpp|rs|swift|scala|sh|bash|sql|vue|svelte|astro)$/i;
  const changedCodeFiles = () => {
    try {
      const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
      if (r.status !== 0) return [];
      return r.stdout.split('\n')
        .map((l) => l.slice(3).trim()).filter(Boolean)
        .map((f) => (f.includes(' -> ') ? f.split(' -> ')[1] : f)) // 改名：取新路徑
        .filter((f) => CODE_EXT.test(f));
    } catch { return []; }
  };
  const securityReview = {
    name: 'security_review', label: '安全審查', readOnly: true,
    description: '對「當前變更」（git 未提交/未追蹤的程式碼檔）做靜態安全審查，找常見高風險樣式：硬編碼機密、命令/SQL 注入、XSS、停用 TLS 驗證、弱雜湊、不安全反序列化等。可傳 paths 指定檔案；純檢查不改檔。交付前跑一次，或使用者要求安全審查時用。',
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: '要審查的檔案（相對路徑）；省略則自動取 git 變更的程式碼檔' } } },
    execute: async (_id, { paths } = {}) => {
      const files = (Array.isArray(paths) && paths.length) ? paths : changedCodeFiles();
      if (!files.length) return txt({ scanned: 0, findings: [], note: '沒有可審查的變更程式碼檔（或非 git 專案）；可用 paths 明確指定檔案。' });
      const findings = [];
      let scanned = 0;
      for (const rel of files.slice(0, 300)) {
        const p = abs(rel);
        if (!existsSync(p)) continue;
        let text; try { text = readFileSync(p, 'utf8'); } catch { continue; }
        if (text.length > 500000 || /\x00/.test(text)) continue; // 略過過大/二進位（null byte）
        scanned++;
        for (const f of scanCode(text)) findings.push({ file: rel, ...f });
      }
      const sorted = sortFindings(findings);
      const bySeverity = sorted.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
      return txt({
        scanned, total: sorted.length, bySeverity,
        findings: sorted.slice(0, 100),
        note: sorted.length
          ? '這些是靜態樣式提示，非全部即漏洞；請人工確認 high 項再交付。'
          : '未發現常見高風險樣式（不代表絕對安全，僅覆蓋常見樣式）。',
      });
    },
  };

  // 程式碼審查（移植自 CC code-review/simplify 的可靜態偵測子集）：品質/清理檢查。
  const codeReview = {
    name: 'code_review', label: '程式碼審查', readOnly: true,
    description: '對「當前變更」的程式碼檔做靜態品質審查，找常見清理項：留下的除錯輸出、被吞掉的錯誤（空 catch/except:pass）、鬆散比較(==)、var 宣告、殘留 TODO/FIXME 等。可傳 paths 指定；純檢查不改檔。注意：只涵蓋機械式樣式，深層語意 bug（邏輯/邊界/競態）仍需你逐段人工審查。交付前搭配 security_review 一起跑。',
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: '要審查的檔案（相對路徑）；省略則自動取 git 變更的程式碼檔' } } },
    execute: async (_id, { paths } = {}) => {
      const files = (Array.isArray(paths) && paths.length) ? paths : changedCodeFiles();
      if (!files.length) return txt({ scanned: 0, findings: [], note: '沒有可審查的變更程式碼檔（或非 git 專案）；可用 paths 明確指定檔案。' });
      const findings = [];
      let scanned = 0;
      for (const rel of files.slice(0, 300)) {
        const p = abs(rel);
        if (!existsSync(p)) continue;
        let text; try { text = readFileSync(p, 'utf8'); } catch { continue; }
        if (text.length > 500000 || /\x00/.test(text)) continue;
        scanned++;
        for (const f of scanQuality(text, langOf(rel))) findings.push({ file: rel, ...f });
      }
      const sorted = sortFindings(findings);
      const bySeverity = sorted.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
      return txt({
        scanned, total: sorted.length, bySeverity,
        findings: sorted.slice(0, 100),
        note: sorted.length
          ? '這些是靜態清理提示；深層語意 bug 需你逐段人工審查。'
          : '未發現常見清理項（不代表無 bug——靜態檢查涵蓋有限，語意問題仍需人工審）。',
      });
    },
  };

  // LSP 診斷（移植自 CC 的語言伺服器智能）：跑對應 language server 取型別錯/未定義/未使用等
  // 真實診斷，比 grep 精準。需該語言的 server 已安裝（未裝則優雅提示安裝哪個）。
  const lspTool = {
    name: 'lsp_diagnostics', label: 'LSP 診斷', readOnly: true,
    description: '用語言伺服器（typescript-language-server / pyright / gopls / rust-analyzer / clangd）對單一檔取真實診斷：型別錯誤、未定義符號、未使用變數等。比 grep/靜態樣式精準。支援 ts/js/py/go/rs/c/cpp；server 未安裝會回報要裝哪個。改檔後想確認沒壞可用它。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '要診斷的檔案（相對路徑）' } }, required: ['path'] },
    execute: async (_id, { path }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      const s = serverFor(p);
      if (!s) return txt({ error: '此副檔名不支援 LSP', path, supported: 'ts js py go rs c cpp' });
      const r = await lspDiagnostics(p, cwd);
      if (!r.ok) return txt({ ok: false, path, reason: r.reason, ...(r.install ? { hint: `安裝 ${r.install} 後即可使用` } : {}) });
      const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
      return txt({ ok: true, path, server: s.cmd, total: r.diagnostics.length, errors, diagnostics: r.diagnostics.slice(0, 100) });
    },
  };

  // LSP 導覽/理解（跳定義 / hover / 符號大綱）——共用同一組 language server。
  const lspErr = (path) => { const s = serverFor(abs(path)); return s ? null : txt({ error: '此副檔名不支援 LSP', path, supported: 'ts js py go rs c cpp' }); };
  const lspDefTool = {
    name: 'lsp_definition', label: '跳定義', readOnly: true,
    description: '用 language server 找某位置符號的「定義」在哪（檔案:行:欄）。比 grep 準（懂 import/範圍/同名）。path 相對路徑，line/col 為 1-based。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, col: { type: 'number' } }, required: ['path', 'line', 'col'] },
    execute: async (_id, { path, line, col }) => {
      const p = abs(path); if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      const e = lspErr(path); if (e) return e;
      const r = await lspDefinition(p, cwd, line, col);
      if (!r.ok) return txt({ ok: false, path, reason: r.reason, ...(r.install ? { hint: `安裝 ${r.install} 後即可使用` } : {}) });
      return txt({ ok: true, count: r.locations.length, locations: r.locations.slice(0, 50) });
    },
  };
  const lspHoverTool = {
    name: 'lsp_hover', label: 'hover 說明', readOnly: true,
    description: '用 language server 取某位置符號的型別/簽章/文件（即 IDE 的 hover）。path 相對路徑，line/col 為 1-based。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, col: { type: 'number' } }, required: ['path', 'line', 'col'] },
    execute: async (_id, { path, line, col }) => {
      const p = abs(path); if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      const e = lspErr(path); if (e) return e;
      const r = await lspHover(p, cwd, line, col);
      if (!r.ok) return txt({ ok: false, path, reason: r.reason, ...(r.install ? { hint: `安裝 ${r.install} 後即可使用` } : {}) });
      return txt({ ok: true, hover: r.hover || '（此位置無 hover 資訊）' });
    },
  };
  const lspSymbolsTool = {
    name: 'lsp_symbols', label: '符號大綱', readOnly: true,
    description: '用 language server 列出一個檔的符號大綱（class/function/method/變數…，含階層與行號）。快速掌握檔案結構，比逐行讀更省。path 相對路徑。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (_id, { path }) => {
      const p = abs(path); if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      const e = lspErr(path); if (e) return e;
      const r = await lspSymbols(p, cwd);
      if (!r.ok) return txt({ ok: false, path, reason: r.reason, ...(r.install ? { hint: `安裝 ${r.install} 後即可使用` } : {}) });
      return txt({ ok: true, count: r.symbols.length, symbols: r.symbols.slice(0, 200) });
    },
  };

  return {
    name: 'coding',
    tools: () => [readTool, lsTool, globTool, grepTool, writeTool, editTool, bashTool, ...bg.tools, webFetch, gitStatus, gitDiff, gitLog, gitCommit, securityReview, codeReview, lspTool, lspDefTool, lspHoverTool, lspSymbolsTool],
    systemPrompt: withBaseRules(SYSTEM_PROMPT),
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
