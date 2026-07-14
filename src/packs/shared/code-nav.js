// 共用的 codebase 導航工具（grep / glob）— coding 與 general pack 共用，避免重複。
// grep 對標 Claude Code：優先用 ripgrep（快 + 支援 context/多行/輸出模式），未安裝時回退內建 JS 遍歷。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });
const IGNORE = new Set(['node_modules', '.git', '.xitto-kernel', '.xitto-code', 'dist', 'build', '.next', 'coverage']);

// ripgrep 是否可用（偵測一次，快取）。裝了就走 rg，語意與 Claude Code 的 Grep 一致。
let _rg;
export function hasRipgrep() {
  if (_rg === undefined) {
    try { _rg = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0; }
    catch { _rg = false; }
  }
  return _rg;
}

// 遞迴收集檔案路徑（跳過 IGNORE 目錄），上限保護
export function walkFiles(dir, out, limit) {
  if (out.length >= limit) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name.startsWith('.') && e.name !== '.env') { if (IGNORE.has(e.name)) continue; }
    if (IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out, limit);
    else out.push(full);
  }
}

// glob 樣式 → 正則。支援 ** 遞迴、* 與 ?、{a,b,c} 花括號展開、[...] 字元類（含 [!..] 取反）。
export function globToRegex(pattern) {
  let re = '';
  let depth = 0; // 花括號巢狀深度：只有在 {} 內的逗號才視為「或」
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') { if (pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (ch === '?') re += '[^/]';
    else if (ch === '{') { re += '(?:'; depth++; }
    else if (ch === '}' && depth > 0) { re += ')'; depth--; }
    else if (ch === ',' && depth > 0) re += '|';
    else if (ch === '[') { // 字元類原樣帶入；glob 的 [!..] 取反轉成正則的 [^..]
      re += '['; if (pattern[i + 1] === '!') { re += '^'; i++; }
    }
    else if (ch === ']') re += ']';
    else if ('.+^$()|\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$');
}

const GREP_DESC = '在檔案內容用正則搜尋（ripgrep 引擎，未裝時回退內建）。回 path:line:文字。'
  + '參數：pattern(正則) · path(起點目錄) · glob(檔名過濾，如 "*.js"、"!*.test.js"、"**/*.ts") · ignoreCase'
  + ' · context(前後各顯示 N 行，僅 content 模式) · multiline(讓 . 跨行、樣式可跨行)'
  + ' · outputMode(content 內容[預設] / files_with_matches 只列有匹配的檔 / count 每檔計數) · headLimit(截斷筆數)。'
  + '自動跳過 node_modules/.git 等目錄與二進位。';

const GREP_PARAMS = {
  type: 'object',
  properties: {
    pattern: { type: 'string' },
    path: { type: 'string' },
    glob: { type: 'string' },
    ignoreCase: { type: 'boolean' },
    context: { type: 'number', description: '前後各顯示 N 行上下文（僅 content 模式）' },
    multiline: { type: 'boolean', description: '多行模式：. 匹配換行，樣式可跨行' },
    outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
    headLimit: { type: 'number', description: '最多回傳幾行（預設 200）' },
  },
  required: ['pattern'],
};

// ripgrep 路徑：組 rg 參數、執行、把輸出正規化成 cwd 相對路徑並截斷。
function grepRg(cwd, abs, { pattern, path, glob, ignoreCase, context, multiline, outputMode = 'content', headLimit }) {
  const base = path ? abs(path) : cwd;
  if (!existsSync(base)) return txt({ error: '目錄不存在', path });
  const cap = Math.min(5000, Math.max(1, headLimit || 200));
  const a = ['--line-number', '--no-heading', '--color', 'never'];
  if (ignoreCase) a.push('--ignore-case');
  if (multiline) a.push('--multiline', '--multiline-dotall');
  for (const d of IGNORE) a.push('-g', '!' + d); // 與內建一致：無論有無 .gitignore 都排除這些目錄
  if (glob) a.push('-g', glob);
  if (outputMode === 'files_with_matches') a.push('--files-with-matches');
  else if (outputMode === 'count') a.push('--count');
  else if (context && context > 0) a.push('--context', String(Math.min(20, context)));
  // 搜尋範圍以「相對於 cwd」傳入並在 cwd 執行 → 輸出即為相對路徑（再去掉可能的 ./ 前綴）
  const rel = path ? (relative(cwd, base) || '.') : '.';
  a.push('--regexp', pattern, rel);
  const r = spawnSync('rg', a, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
  if (r.error) return txt({ error: r.error.message });
  if (r.status === 1) return txt('(無匹配)');           // rg：1 = 沒有匹配
  if (r.status !== 0) return txt({ error: (r.stderr || 'ripgrep 執行失敗').trim().slice(0, 500) });
  const clean = (l) => l.replace(/^\.\//, '');
  let lines = (r.stdout || '').replace(/\s+$/, '').split('\n').filter(Boolean).map(clean);
  const truncated = lines.length > cap;
  if (truncated) lines = lines.slice(0, cap);
  if (!lines.length) return txt('(無匹配)');
  return txt(lines.join('\n') + (truncated ? `\n…（結果已截斷至 ${cap}）` : ''));
}

// 內建 JS 回退：無 ripgrep 時，遍歷檔案套正則。支援 context / outputMode / headLimit。
function grepJs(cwd, abs, { pattern, path, glob, ignoreCase, context, outputMode = 'content', headLimit }) {
  let re; try { re = new RegExp(pattern, ignoreCase ? 'i' : ''); } catch (e) { return txt({ error: '正則無效：' + e.message }); }
  const base = path ? abs(path) : cwd;
  if (!existsSync(base)) return txt({ error: '目錄不存在', path });
  const cap = Math.min(5000, Math.max(1, headLimit || 200));
  const ctx = Math.min(20, Math.max(0, context || 0));
  const gre = glob ? globToRegex(glob) : null;
  const files = []; walkFiles(base, files, 8000);
  const pick = (f) => !gre || gre.test(f.split('/').pop());

  if (outputMode === 'files_with_matches' || outputMode === 'count') {
    const out = [];
    for (const f of files) {
      if (!pick(f)) continue;
      let content; try { content = readFileSync(f, 'utf8'); } catch { continue; }
      if (content.includes('\x00')) continue;
      const n = content.split('\n').filter((l) => re.test(l)).length;
      if (n > 0) { out.push(outputMode === 'count' ? `${relative(cwd, f)}:${n}` : relative(cwd, f)); if (out.length >= cap) break; }
    }
    return txt(out.length ? out.join('\n') : '(無匹配)');
  }

  const hits = [];
  for (const f of files) {
    if (!pick(f)) continue;
    let content; try { content = readFileSync(f, 'utf8'); } catch { continue; }
    if (content.includes('\x00')) continue;
    const lines = content.split('\n'); const rel = relative(cwd, f);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (ctx > 0) {
        for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) hits.push(`${rel}:${j + 1}:${lines[j].slice(0, 200)}`);
      } else hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      if (hits.length >= cap) break;
    }
    if (hits.length >= cap) break;
  }
  return txt(hits.length ? hits.join('\n') + (hits.length >= cap ? `\n…（結果已截斷至 ${cap}）` : '') : '(無匹配)');
}

export function createGrepTool(cwd) {
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));
  return {
    name: 'grep', label: '搜尋內容', readOnly: true,
    description: GREP_DESC,
    parameters: GREP_PARAMS,
    execute: async (_id, args) => (hasRipgrep() ? grepRg(cwd, abs, args) : grepJs(cwd, abs, args)),
  };
}

export function createGlobTool(cwd) {
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));
  return {
    name: 'glob', label: '找檔', readOnly: true,
    description: '用萬用字元樣式找檔（** 遞迴、* ?、{a,b} 展開、[..] 字元類），相對路徑比對，結果按最近修改排序。如 "src/**/*.js"、"**/*.{ts,tsx}"。',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
    execute: async (_id, { pattern, path }) => {
      const base = path ? abs(path) : cwd;
      if (!existsSync(base)) return txt({ error: '目錄不存在', path });
      const files = []; walkFiles(base, files, 8000);
      const re = globToRegex(pattern);
      // 最近修改的排前面（對標 Claude Code 的 glob，符合「剛動過的檔最相關」直覺）
      const matched = files
        .filter((f) => re.test(relative(cwd, f)))
        .map((f) => { let m = 0; try { m = statSync(f).mtimeMs; } catch { /* 略 */ } return { rel: relative(cwd, f), m }; })
        .sort((x, y) => y.m - x.m)
        .slice(0, 200)
        .map((x) => x.rel);
      return txt({ pattern, count: matched.length, files: matched });
    },
  };
}
