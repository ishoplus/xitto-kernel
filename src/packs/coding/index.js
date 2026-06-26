// coding pack — 參考 DomainPack（對標 xitto-code 的編碼能力）。
// 工具以輕量真實實作示範（read/ls/write/edit 真的動檔案）；bash 走 shell。
// read-before-edit 守衛與 read 工具透過閉包共享 readFiles 狀態，故能真實生效。
// 對應 docs/05-example-packs.md「A. coding pack」。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是嚴謹的編碼 agent。準則：',
  '- 編輯既有檔案前必先 read 它的當前內容，不基於臆測修改。',
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

  const readTool = {
    name: 'read', label: '讀檔', description: '讀取檔案內容', readOnly: true,
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (_id, { path }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      readFiles.add(p);
      return txt(readFileSync(p, 'utf8'));
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
      const p = abs(path);
      writeFileSync(p, content ?? '', 'utf8');
      readFiles.add(p); // 寫過即視為已知內容
      return txt({ written: path, bytes: Buffer.byteLength(content ?? '') });
    },
  };

  const editTool = {
    name: 'edit', label: '編輯', description: '把檔案中的 oldText 換成 newText', mutating: true,
    parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] },
    execute: async (_id, { path, oldText, newText }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      const before = readFileSync(p, 'utf8');
      if (!before.includes(oldText)) return txt({ error: 'oldText 未找到', path });
      writeFileSync(p, before.replace(oldText, newText), 'utf8');
      return txt({ edited: path });
    },
  };

  const bashTool = {
    name: 'bash', label: 'bash', description: '執行 shell 命令', mutating: true, sandboxable: true,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (_id, { command }) => {
      // 註：真實的串流/逾時/沙箱包裹由移植 xitto-code 的 bash 工具取得（見 docs/04 第 3 項）。
      try { return txt(execSync(command, { cwd, encoding: 'utf8', timeout: 120000 }) || '(no output)'); }
      catch (e) { return txt({ error: e.message, stdout: e.stdout, stderr: e.stderr }); }
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
    tools: () => [readTool, lsTool, writeTool, editTool, bashTool, gitStatus, gitDiff, gitLog, gitCommit],
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
