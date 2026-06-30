// 文件產出（與 doc-extract 對稱：那個「讀」Office/PDF，這個「產」可交付文件）。
// 路線 A（零 npm 相依）：md → 乾淨可列印 HTML（中文用系統字體，HTML 本身即可交付）；
//   PDF = 偵測系統渲染器（Chrome headless / wkhtmltopdf / soffice）把 HTML 轉檔；無則回 HTML + 提示。
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// 行內：code / 粗體 / 斜體 / 連結（先 esc 再套）
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
  .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');

// 極簡 markdown → HTML body（標題/段落/清單/引言/code/分隔線/GFM 表格）。零相依。
export function mdToBody(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = [];
  let inCode = false, buf = [], inList = false;
  const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isSep = (s) => s.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
  const closeL = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      if (inCode) { out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>'); buf = []; inCode = false; }
      else { closeL(); inCode = true; }
      continue;
    }
    if (inCode) { buf.push(ln); continue; }
    const h = ln.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeL(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) { closeL(); out.push('<hr>'); continue; }
    if (ln.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && isSep(lines[i + 1])) {
      closeL();
      const header = cells(ln); let j = i + 2; const body = [];
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') { body.push(cells(lines[j])); j++; }
      out.push('<table><thead><tr>' + header.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead>'
        + (body.length ? '<tbody>' + body.map((r) => '<tr>' + header.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody>' : '')
        + '</table>');
      i = j - 1; continue;
    }
    if (ln.startsWith('> ')) { closeL(); out.push(`<blockquote>${inline(ln.slice(2))}</blockquote>`); continue; }
    const li = ln.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(li[1]) + '</li>'); continue; }
    if (ln.trim() === '') { closeL(); continue; }
    closeL(); out.push('<p>' + inline(ln) + '</p>');
  }
  closeL();
  if (inCode) out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
  return out.join('\n');
}

// 完整可列印 HTML 文件（中文友善字體 + 列印樣式）。
export function mdToHtml(md, { title = '' } = {}) {
  const body = mdToBody(md);
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${escAttr(title || '文件')}</title>
<style>
@page { size: A4; margin: 20mm; }
html { font-size: 12pt; }
body { font-family: -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans CJK SC", sans-serif; line-height: 1.7; color: #1a1a1a; max-width: 760px; margin: 0 auto; padding: 24px; }
h1,h2,h3,h4 { line-height: 1.3; margin: 1.2em 0 .5em; }
h1 { font-size: 1.8em; border-bottom: 2px solid #e2e2e2; padding-bottom: .2em; }
h2 { font-size: 1.4em; } h3 { font-size: 1.15em; }
p { margin: .6em 0; } ul { margin: .6em 0; padding-left: 1.4em; }
code { background: #f3f3f5; padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .92em; }
pre { background: #f3f3f5; padding: 12px 14px; border-radius: 8px; overflow-x: auto; } pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #ccc; margin: .6em 0; padding-left: 14px; color: #555; }
a { color: #2257d6; }
table { border-collapse: collapse; margin: .8em 0; width: 100%; }
th,td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; } th { background: #f6f6f8; }
hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
</style></head><body>
${body}
</body></html>`;
}

// 取 markdown 第一個 GFM 表格 → 列陣列（每列為儲存格字串陣列）；無表格回 null。
export function mdTableToRows(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isSep = (s) => s.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].includes('|') && lines[i + 1].includes('|') && isSep(lines[i + 1])) {
      const rows = [cells(lines[i])]; let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') { rows.push(cells(lines[j])); j++; }
      return rows;
    }
  }
  return null;
}
// 列陣列 → CSV 字串（RFC4180 轉義：含 , " 換行 的欄位加引號、內部 " 變 ""）。
export function toCsv(rows) {
  const e = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return rows.map((r) => r.map(e).join(',')).join('\r\n');
}

// 偵測可用的 HTML→PDF 渲染器，回 { kind, bin } 或 null。
function has(bin) {
  if (bin.includes('/')) return existsSync(bin) ? bin : null;
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}
export function detectRenderer() {
  const chrome = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean);
  for (const b of chrome) { const p = has(b); if (p) return { kind: 'chrome', bin: p }; }
  for (const b of ['wkhtmltopdf']) { const p = has(b); if (p) return { kind: 'wkhtmltopdf', bin: p }; }
  for (const b of ['soffice', 'libreoffice']) { const p = has(b); if (p) return { kind: 'soffice', bin: p }; }
  return null;
}

const isPdf = (p) => { try { return existsSync(p) && readFileSync(p).subarray(0, 5).toString() === '%PDF-'; } catch { return false; } };
const isZip = (p) => { try { return existsSync(p) && readFileSync(p).subarray(0, 2).toString() === 'PK'; } catch { return false; } };

// DOCX 轉檔器：pandoc（HTML→docx 最佳）> soffice。回 { kind, bin } 或 null。
function detectDocx() {
  const p = has('pandoc'); if (p) return { kind: 'pandoc', bin: p };
  for (const b of ['soffice', 'libreoffice']) { const q = has(b); if (q) return { kind: 'soffice', bin: q }; }
  return null;
}
function renderHtmlToDocx(htmlPath, outPath, r) {
  try {
    if (r.kind === 'pandoc') {
      spawnSync(r.bin, [htmlPath, '-o', outPath], { encoding: 'utf8', timeout: 60000 });
    } else {
      const od = dirname(outPath);
      spawnSync(r.bin, ['--headless', '--convert-to', 'docx', '--outdir', od, htmlPath], { encoding: 'utf8', timeout: 60000 });
      const produced = join(od, basename(htmlPath).replace(/\.html?$/i, '') + '.docx');
      if (produced !== outPath && isZip(produced)) { try { writeFileSync(outPath, readFileSync(produced)); rmSync(produced); } catch { /* 略 */ } }
    }
    return isZip(outPath) ? { ok: true, tool: r.kind } : { ok: false, reason: `${r.kind} 未產生有效 docx` };
  } catch (e) { return { ok: false, reason: e?.message || String(e) }; }
}

// html 檔 → pdf（用偵測到的渲染器）。回 { ok, tool } 或 { ok:false, reason }。
function renderHtmlToPdf(htmlPath, outPath, r) {
  try {
    if (r.kind === 'chrome') {
      spawnSync(r.bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--print-to-pdf=${outPath}`, 'file://' + htmlPath], { encoding: 'utf8', timeout: 60000 });
      if (!isPdf(outPath)) spawnSync(r.bin, ['--headless', '--disable-gpu', '--no-sandbox', `--print-to-pdf=${outPath}`, 'file://' + htmlPath], { encoding: 'utf8', timeout: 60000 });
    } else if (r.kind === 'wkhtmltopdf') {
      spawnSync(r.bin, ['-q', htmlPath, outPath], { encoding: 'utf8', timeout: 60000 });
    } else if (r.kind === 'soffice') {
      const od = dirname(outPath);
      spawnSync(r.bin, ['--headless', '--convert-to', 'pdf', '--outdir', od, htmlPath], { encoding: 'utf8', timeout: 60000 });
      const produced = join(od, basename(htmlPath).replace(/\.html?$/i, '') + '.pdf');
      if (produced !== outPath && isPdf(produced)) { try { writeFileSync(outPath, readFileSync(produced)); rmSync(produced); } catch { /* 略 */ } }
    }
    return isPdf(outPath) ? { ok: true, tool: r.kind } : { ok: false, reason: `${r.kind} 轉檔未產生有效 PDF` };
  } catch (e) { return { ok: false, reason: e?.message || String(e) }; }
}

// 各格式的轉檔規格（偵測器 + 轉檔函式 + 缺工具時的提示）。
const FORMATS = {
  pdf: { detect: detectRenderer, render: renderHtmlToPdf, tools: 'chrome / wkhtmltopdf / soffice' },
  docx: { detect: detectDocx, render: renderHtmlToDocx, tools: 'pandoc / soffice' },
};

/**
 * 產生文件成品。依 outPath 副檔名：.pdf / .docx → 轉檔（無工具則改產同名 .html 並提示）；其餘 → HTML。
 * @returns {{ ok:boolean, format:'pdf'|'docx'|'html', path:string, bytes:number, tool?:string, note?:string }}
 */
export function generateDoc(markdown, outPath, { title = '' } = {}) {
  const ext = (outPath.match(/\.([a-z0-9]+)$/i)?.[1] || 'html').toLowerCase();

  // CSV（零相依，Excel 可開）：取 markdown 第一個表格 → CSV + UTF-8 BOM（讓 Excel 正確顯示中文）。
  if (ext === 'csv') {
    const rows = mdTableToRows(markdown);
    if (!rows) return { ok: false, format: 'csv', path: outPath, bytes: 0, note: '找不到可轉 CSV 的表格——請提供 GFM 表格（| 欄1 | 欄2 | 後接 | --- | --- |）。' };
    const csv = '\uFEFF' + toCsv(rows);
    writeFileSync(outPath, csv);
    return { ok: true, format: 'csv', path: outPath, bytes: Buffer.byteLength(csv), rows: rows.length };
  }

  const html = mdToHtml(markdown, { title });
  const writeHtml = (p, note) => { writeFileSync(p, html); return { ok: true, format: 'html', path: p, bytes: html.length, ...(note ? { note } : {}) }; };

  if (ext === 'html' || ext === 'htm') return writeHtml(outPath);
  const spec = FORMATS[ext];
  if (!spec) return writeHtml(outPath, `未知格式 .${ext}，已將 HTML 內容寫入該檔。`);

  const tool = spec.detect();
  const htmlPath = outPath.replace(/\.[a-z0-9]+$/i, '.html');
  if (!tool) return writeHtml(htmlPath, `未偵測到 ${ext.toUpperCase()} 轉檔工具（${spec.tools}），已產出 HTML。安裝其一即可產 ${ext.toUpperCase()}。`);

  const tmp = mkdtempSync(join(tmpdir(), 'docgen-'));
  const htmlTmp = join(tmp, 'doc.html');
  try {
    writeFileSync(htmlTmp, html);
    const r = spec.render(htmlTmp, outPath, tool);
    if (r.ok) { let bytes = 0; try { bytes = readFileSync(outPath).length; } catch { /* 略 */ } return { ok: true, format: ext, path: outPath, bytes, tool: r.tool }; }
    return writeHtml(htmlPath, `${ext.toUpperCase()} 轉檔失敗（${r.reason}），已產出 HTML。`);
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 略 */ } }
}
