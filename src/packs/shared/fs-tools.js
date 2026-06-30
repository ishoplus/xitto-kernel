// 共用檔案/shell 工具（read/ls/write/edit/bash）+ read-before-edit 守衛。
// 多個 pack（coding/devops…）共用；read 附行號、edit 唯一性檢查、bash 用 spawnSync 捕捉 stderr。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDocFile, extractDocText, DOC_EXTENSIONS } from './doc-extract.js';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

/**
 * @param {string} cwd
 * @returns {{ read, ls, write, edit, bash, readBeforeEdit }}
 */
export function createFsTools(cwd) {
  // 已讀檔案 → 讀取當下的 mtimeMs（用 realpath 當 key）。供 read-before-write 與讀後變更檢測。
  const readFiles = new Map();
  const realCwd = realpathSync(cwd);
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));
  // 把路徑正規化到「最近存在的祖先取 realpath，再接回不存在的尾段」，
  // 同時解析 symlink 又能處理尚未建立的深層路徑（macOS /var→/private/var 也正確）。
  const canonical = (target) => {
    let cur = target; const tail = [];
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) break;
      tail.unshift(basename(cur)); cur = parent;
    }
    const base = existsSync(cur) ? realpathSync(cur) : cur;
    return tail.length ? join(base, ...tail) : base;
  };
  // 寫檔限制在工作目錄內：逃逸 cwd（如 /tmp、/app）或經由 symlink 指向外部 → 回 null。讀檔不限制。
  const within = (p) => {
    const full = abs(p);
    const r = relative(realCwd, canonical(full));
    return (r === '' || (!r.startsWith('..') && !isAbsolute(r))) ? full : null;
  };
  const escapeErr = (path) => txt({ error: `只能寫在工作目錄內：${cwd}`, hint: '請用相對路徑（如 report.md）', path });
  // 記錄已讀（含 mtime）。寫檔後也呼叫以更新基準，避免連續寫被誤判為「被改動」。
  const markRead = (p) => { try { readFiles.set(realpathSync(p), statSync(p).mtimeMs); } catch { /* 不存在則略過 */ } };

  const read = {
    name: 'read', label: '讀檔', readOnly: true,
    description: `讀取檔案內容（每行附行號）。大檔可用 offset(起始行,1-based)+limit(行數)。也能讀 Word/Excel/PPT/PDF 等文件（${DOC_EXTENSIONS.join(' ')}），自動萃取成文字。`,
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] },
    execute: async (_id, { path, offset, limit }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      try {
        const st = statSync(p);
        if (st.isDirectory()) return txt({ error: '這是目錄，請用 ls', path });
        if (st.size > 50 * 1024 * 1024) return txt({ error: `檔案過大（${(st.size / 1048576).toFixed(1)}MB），請用 bash 處理`, path });
        let content;
        if (isDocFile(p)) {                                    // Word/Excel/PPT/ODF/RTF/PDF → 萃取文字
          try { content = extractDocText(p); }
          catch (e) { return txt({ error: '文件解析失敗', detail: e.message, path }); }
        } else {
          const buf = readFileSync(p);
          if (buf.includes(0)) return txt({ error: '二進位檔案，無法以文字讀取', path, bytes: st.size }); // null byte → 視為二進位
          content = buf.toString('utf8');
        }
        markRead(p);
        const lines = content.split('\n');
        const start = Math.max(0, (offset || 1) - 1);
        const count = limit && limit > 0 ? limit : 2000;
        const numbered = lines.slice(start, start + count).map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n');
        const remain = lines.length - (start + count);
        return txt(numbered + (remain > 0 ? `\n… 還有 ${remain} 行（offset=${start + count + 1}）` : ''));
      } catch (e) {
        return txt({ error: '讀檔失敗', detail: e.message, path });
      }
    },
  };
  const ls = {
    name: 'ls', label: '列目錄', readOnly: true, description: '列出目錄內容',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (_id, { path = '.' }) => {
      const p = abs(path);
      if (!existsSync(p)) return txt({ error: '目錄不存在', path });
      try {
        if (!statSync(p).isDirectory()) return txt({ error: '這不是目錄，請用 read', path });
        const names = readdirSync(p).map((n) => {
          let isDir = false;
          try { isDir = statSync(join(p, n)).isDirectory(); } catch { /* 壞掉的 symlink：當作一般檔案列出，不讓整個 ls 失敗 */ }
          return n + (isDir ? '/' : '');
        });
        return txt(names.join('\n') || '(空目錄)');
      } catch (e) {
        return txt({ error: '列目錄失敗', detail: e.message, path });
      }
    },
  };
  const write = {
    name: 'write', label: '寫檔', mutating: true, description: '建立或覆寫檔案',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async (_id, { path, content }) => {
      const p = within(path); if (!p) return escapeErr(path);
      try {
        const body = content ?? '';
        mkdirSync(dirname(p), { recursive: true });          // ① 自動建父目錄
        const tmp = `${p}.tmp-${process.pid}`;               // ② 原子寫：暫存檔 + rename
        writeFileSync(tmp, body, 'utf8');
        renameSync(tmp, p);
        markRead(p);                                         // 更新讀取基準（含新 mtime）
        return txt({ written: path, bytes: Buffer.byteLength(body) });
      } catch (e) {                                          // ③ 結構化錯誤，不向上拋
        return txt({ error: '寫檔失敗', detail: e.message, path });
      }
    },
  };
  const edit = {
    name: 'edit', label: '編輯', mutating: true,
    description: '把 oldText 換成 newText。oldText 須唯一（多次出現需 replaceAll）。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldText', 'newText'] },
    execute: async (_id, { path, oldText, newText, replaceAll }) => {
      const p = within(path); if (!p) return escapeErr(path);
      if (!existsSync(p)) return txt({ error: '檔案不存在', path });
      try {
        const before = readFileSync(p, 'utf8');
        const n = before.split(oldText).length - 1;
        if (n === 0) return txt({ error: 'oldText 未找到（先 read 確認）', path });
        if (n > 1 && !replaceAll) return txt({ error: `oldText 出現 ${n} 次，請更精確或設 replaceAll`, path });
        const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
        const tmp = `${p}.tmp-${process.pid}`;               // ② 原子寫
        writeFileSync(tmp, after, 'utf8');
        renameSync(tmp, p);
        markRead(p);                                         // 更新讀取基準
        return txt({ edited: path, replaced: replaceAll ? n : 1 });
      } catch (e) {
        return txt({ error: '編輯失敗', detail: e.message, path });
      }
    },
  };
  const bash = {
    name: 'bash', label: 'bash', mutating: true, sandboxable: true,
    description: '執行 shell 命令（可選 timeout 秒數，預設 120）。長時間/常駐用 bash_bg。',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] },
    execute: async (_id, { command, timeout }) => {
      const ms = Math.min(600, Math.max(1, timeout || 120)) * 1000;
      const r = spawnSync(command, { shell: true, cwd, encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      if (r.error) return txt({ error: r.error.message, output });
      if (r.status !== 0) return txt({ error: `命令結束碼 ${r.status}`, output: output || '(no output)' });
      return txt(output || '(no output)');
    },
  };

  // read-before-edit 守衛（給 pack 的 preToolPolicy 用）+ 讀後變更檢測。
  const readBeforeEdit = (ctx) => {
    if ((ctx.name === 'edit' || ctx.name === 'write') && ctx.args?.path) {
      const p = abs(ctx.args.path);
      if (!existsSync(p)) return undefined; // 新檔不需先讀
      let rp; try { rp = realpathSync(p); } catch { rp = p; }
      const seen = readFiles.get(rp);
      if (seen === undefined) return { block: true, reason: `請先 read ${ctx.args.path} 再編輯。` };
      // 讀取後檔案被外部改動 → 擋下，避免蓋掉別人的修改（對齊 Claude Code staleness）
      let mtime; try { mtime = statSync(p).mtimeMs; } catch { mtime = seen; }
      if (mtime > seen) return { block: true, reason: `${ctx.args.path} 在你 read 之後被改動，請重新 read 再寫。` };
    }
    return undefined;
  };

  return { read, ls, write, edit, bash, readBeforeEdit };
}
