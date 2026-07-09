// 文件文字萃取（零相依）：把 Word/Excel/PPT/OpenDocument/RTF/PDF 轉成純文字，讓 read 能直接讀。
// 設計：Office/ODF 本質是 ZIP+XML → 用內建 zlib 解壓、剝 XML 標籤取文字；RTF 純 JS 去控制字；
//       PDF 無純 JS 可靠解法 → 退回系統 pdftotext（poppler），沒有就給清楚提示。不引入任何 npm 相依。
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';

// 支援的副檔名 → 類型。純文字（txt/md/csv/json…）不在此，read 本來就能讀。
const EXT = {
  '.docx': 'docx', '.pptx': 'pptx', '.xlsx': 'xlsx',
  '.odt': 'odf', '.odp': 'odf', '.ods': 'odf',
  '.rtf': 'rtf', '.pdf': 'pdf',
};

/** 支援萃取的文件類型清單（給工具描述用）。 */
export const DOC_EXTENSIONS = Object.keys(EXT);

/** 這個路徑是否為需要萃取的文件（依副檔名）。 */
export function isDocFile(path) {
  return Object.prototype.hasOwnProperty.call(EXT, extname(String(path)).toLowerCase());
}

/**
 * 把文件萃取成純文字。失敗丟 Error（呼叫端轉成結構化錯誤）。
 * @param {string} path 絕對或相對路徑（呼叫端先解析好）
 * @returns {string}
 */
export function extractDocText(path) {
  return extractDoc(path).text;
}

/**
 * 把文件萃取成結構化資料。預設呼叫端可直接取 text；structured 欄位供 Office-aware tools 使用。
 * @param {string} path 絕對或相對路徑（呼叫端先解析好）
 * @returns {{ kind:string, text:string, blocks?:Array, slides?:Array, sheets?:Array }}
 */
export function extractDoc(path) {
  const kind = EXT[extname(path).toLowerCase()];
  if (!kind) throw new Error(`不支援的文件類型：${extname(path)}`);
  if (kind === 'pdf') return { kind, text: extractPdf(path) };
  const buf = readFileSync(path);
  if (kind === 'rtf') return { kind, text: tidy(rtfToText(buf.toString('latin1'))) };
  // 其餘皆為 ZIP 容器（OOXML / ODF）
  const zip = readZip(buf);
  if (kind === 'docx') return docxDoc(zip);
  if (kind === 'pptx') return pptxDoc(zip);
  if (kind === 'xlsx') return xlsxDoc(zip);
  if (kind === 'odf') return { kind, text: tidy(odfText(zip)) };
  throw new Error(`未處理的類型：${kind}`);
}

// ── ZIP 讀取（純 Node，支援 stored/deflate，不支援 ZIP64；Office 檔幾乎用不到）──────────
function readZip(buf) {
  // 從尾端找 EOCD（簽章 0x06054b50；comment 最長 65535）
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('不是有效的 ZIP/Office 檔（找不到中央目錄）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map(); // name -> { method, compSize, localOff }
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  // 取出某個 entry 的解壓內容（二進位）；文字 entry 再轉 utf8。
  const readBuffer = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const lo = e.localOff;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('ZIP local header 損壞');
    const nameLen = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const start = lo + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.compSize);
    const out = e.method === 0 ? data : e.method === 8 ? inflateRawSync(data) : null;
    if (out == null) throw new Error(`不支援的 ZIP 壓縮方式 ${e.method}`);
    return Buffer.from(out);
  };
  const read = (name) => readBuffer(name)?.toString('utf8') ?? null;
  return { names: () => [...entries.keys()], read, readBuffer };
}

// ── XML 工具 ───────────────────────────────────────────────────────────────
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&'); // amp 最後解，避免二次解碼
}
// 把指定的「分段/tab/換行」標籤先轉成對應字元，再剝掉其餘所有標籤，最後解實體。
function xmlToText(xml, { para = [], br = [], tab = [] } = {}) {
  let s = xml;
  for (const t of br) s = s.replace(new RegExp(`<${t}\\b[^>]*/?>`, 'g'), '\n');
  for (const t of tab) s = s.replace(new RegExp(`<${t}\\b[^>]*/?>`, 'g'), '\t');
  for (const t of para) s = s.replace(new RegExp(`</${t}>`, 'g'), '\n');
  return decodeEntities(s.replace(/<[^>]+>/g, ''));
}
function stripTags(xml) { return decodeEntities(xml.replace(/<[^>]+>/g, '')); }

// 收尾：去行尾空白、壓掉 3+ 連續空行、去頭尾空白。
function tidy(s) {
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── 各格式 ─────────────────────────────────────────────────────────────────
function docxDoc(zip) {
  const xml = zip.read('word/document.xml');
  if (xml == null) throw new Error('docx 缺少 word/document.xml');
  const blocks = [];
  for (const m of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:tbl\b[\s\S]*?<\/w:tbl>/g)) {
    const node = m[0];
    if (node.startsWith('<w:tbl')) {
      const rows = [...node.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(([row]) =>
        [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(([cell]) => tidy(xmlToText(cell, { para: ['w:p'], br: ['w:br', 'w:cr'], tab: ['w:tab'] })))
      );
      blocks.push({ type: 'table', rows });
    } else {
      const text = tidy(xmlToText(node, { para: ['w:p'], br: ['w:br', 'w:cr'], tab: ['w:tab'] }));
      if (text) blocks.push({ type: 'paragraph', text });
    }
  }
  const text = tidy(blocks.map((b) => b.type === 'table' ? tableToText(b.rows) : b.text).join('\n'));
  return { kind: 'docx', text, blocks };
}

function pptxDoc(zip) {
  const slides = zip.names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b));
  if (!slides.length) throw new Error('pptx 找不到任何投影片');
  const out = slides.map((n, i) => {
    const xml = zip.read(n) || '';
    const blocks = pptxBlocks(xml);
    const tables = pptxTables(xml);
    const charts = pptxCharts(zip, n);
    const structuredText = [
        blocks.map((b) => b.paragraphs.join('\n')).join('\n'),
        ...tables.map((t) => tableToText(t.rows)),
        ...charts.map((c) => chartToText(c)),
      ].filter(Boolean).join('\n');
    const text = tidy(structuredText || xmlToText(xml, { para: ['a:p'], br: ['a:br'] }));
    const title = blocks.find((b) => ['title', 'ctrTitle'].includes(b.role))?.paragraphs.join('\n') || '';
    const body = blocks.filter((b) => !['title', 'ctrTitle'].includes(b.role)).flatMap((b) => b.paragraphs);
    const images = pptxImages(zip, n);
    return { index: i + 1, path: n, text, title, body, blocks, images, tables, charts };
  });
  return { kind: 'pptx', text: out.map((s) => `--- 投影片 ${s.index} ---\n${s.text}`).join('\n\n'), slides: out };
}
function slideNo(n) { return +(n.match(/slide(\d+)\.xml$/) || [])[1] || 0; }
function pptxBlocks(xml) {
  return [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map(([shape]) => {
    const role = (shape.match(/<p:ph\b[^>]*\btype="([^"]+)"/) || [])[1] || 'text';
    const paragraphs = [...shape.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
      .map(([p]) => tidy(xmlToText(p, { br: ['a:br'] })))
      .filter(Boolean);
    return paragraphs.length ? { role, paragraphs } : null;
  }).filter(Boolean);
}
function pptxTables(xml) {
  return [...xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/g)].map(([tbl], i) => {
    const rows = [...tbl.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map(([tr]) =>
      [...tr.matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map(([tc]) => tidy(xmlToText(tc, { para: ['a:p'], br: ['a:br'] })))
    );
    return rows.length ? { index: i + 1, rows } : null;
  }).filter(Boolean);
}
const PPTX_IMAGE_MAX_BYTES = 1_500_000;
const PPTX_IMAGE_MAX_COUNT = 6;
function pptxImages(zip, slidePath) {
  const relsPath = slidePath.replace(/^(.+\/)([^/]+)$/, '$1_rels/$2.rels');
  const rels = zip.read(relsPath) || '';
  const images = [];
  for (const [, attrs] of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    if (!/\bType="[^"]*\/image"/.test(attrs)) continue;
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    if (!target) continue;
    const path = normalizePptxRel(slidePath, decodeEntities(target));
    const data = zip.readBuffer(path);
    if (!data || data.length > PPTX_IMAGE_MAX_BYTES) continue;
    const mime = imageMime(path);
    if (!mime) continue;
    images.push({
      name: path.split('/').pop() || path,
      path,
      mime,
      size: data.length,
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
    });
    if (images.length >= PPTX_IMAGE_MAX_COUNT) break;
  }
  return images;
}
function normalizePptxRel(sourcePath, target) {
  if (target.startsWith('/')) return target.replace(/^\//, '');
  const parts = sourcePath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}
function imageMime(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || '';
}

function pptxCharts(zip, slidePath) {
  const relsPath = slidePath.replace(/^(.+\/)([^/]+)$/, '$1_rels/$2.rels');
  const rels = zip.read(relsPath) || '';
  const charts = [];
  for (const [, attrs] of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    if (!/\bType="[^"]*\/chart"/.test(attrs)) continue;
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    if (!target) continue;
    const path = normalizePptxRel(slidePath, decodeEntities(target));
    const xml = zip.read(path);
    if (!xml) continue;
    charts.push(parsePptxChart(xml, path));
  }
  return charts;
}
function parsePptxChart(xml, path) {
  const type = xml.includes('<c:lineChart') ? 'line' : xml.includes('<c:pieChart') ? 'pie' : xml.includes('<c:barChart') ? 'bar' : 'chart';
  const title = tidy(xmlToText((xml.match(/<c:title\b[\s\S]*?<\/c:title>/) || [])[0] || '', { para: ['a:p'] })) || path.split('/').pop() || 'chart';
  const series = [...xml.matchAll(/<c:ser\b[\s\S]*?<\/c:ser>/g)].map(([ser], i) => {
    const name = stripTags((ser.match(/<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>[\s\S]*?<\/c:tx>/) || [])[1] || `Series ${i + 1}`);
    const categories = chartPts((ser.match(/<c:cat\b[\s\S]*?<\/c:cat>/) || [])[0] || '');
    const values = chartPts((ser.match(/<c:val\b[\s\S]*?<\/c:val>/) || [])[0] || '').map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    });
    return { name, categories, values };
  });
  return { path, type, title, series };
}
function chartPts(xml) {
  return [...xml.matchAll(/<c:pt\b[\s\S]*?<c:v>([\s\S]*?)<\/c:v>[\s\S]*?<\/c:pt>/g)].map(([, v]) => decodeEntities(stripTags(v)));
}
function chartToText(chart) {
  const lines = [`圖表：${chart.title} (${chart.type})`];
  for (const s of chart.series || []) {
    const pairs = (s.categories || []).map((c, i) => `${c}:${s.values?.[i] ?? ''}`).join(', ');
    lines.push(`${s.name}: ${pairs}`);
  }
  return lines.join('\n');
}

function xlsxDoc(zip) {
  // 共用字串表：每個 <si> 串接其底下所有 <t>
  const ssXml = zip.read('xl/sharedStrings.xml') || '';
  const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    ([, si]) => [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1])).join('')
  );
  const sheets = workbookSheets(zip);
  if (!sheets.length) throw new Error('xlsx 找不到任何工作表');
  const out = sheets.map((sheet, i) => {
    const xml = zip.read(sheet.path) || '';
    const merges = [...xml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)].map(([, ref]) => decodeEntities(ref));
    const rows = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].map(([, rowAttrs, rowXml], rowIdx) => {
      const rowNo = +(rowAttrs.match(/\br="(\d+)"/) || [])[1] || rowIdx + 1;
      const cells = [];
      for (const [, attrs, inner] of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const ref = (attrs.match(/\br="([A-Z]+)(\d+)"/i) || [])[1];
        const col = ref ? colToIndex(ref) : cells.length;
        const t = (attrs.match(/t="([^"]+)"/) || [])[1];
        const formula = stripTags((inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/) || [])[1] || '').trim();
        let value = '';
        if (t === 's') { const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1]; value = shared[+v] ?? ''; }
        else if (t === 'inlineStr' || t === 'str') value = stripTags(inner);
        else if (t === 'b') value = ((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] === '1') ? 'TRUE' : 'FALSE';
        else if (t === 'e') value = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
        else {
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
          value = decodeEntities(v);
        }
        if (!value && formula) value = `=${formula}`;
        cells[col] = { ref: ref ? `${ref}${rowNo}` : '', value, formula };
      }
      const width = cells.length;
      const values = Array.from({ length: width }, (_, k) => cells[k]?.value || '');
      return { number: rowNo, cells: values };
    });
    const formulas = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(([, attrs, inner]) => {
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/i) || [])[1] || '';
      const formula = stripTags((inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/) || [])[1] || '').trim();
      const value = decodeEntities((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      return formula ? { ref, formula, value } : null;
    }).filter(Boolean);
    return { index: i + 1, name: sheet.name || `工作表 ${i + 1}`, path: sheet.path, rows, merges, formulas };
  });
  return {
    kind: 'xlsx',
    text: out.map((s) => `--- ${s.name} ---\n${s.rows.map((r) => r.cells.join('\t')).join('\n')}`).join('\n\n'),
    sheets: out,
  };
}
function workbookSheets(zip) {
  const workbook = zip.read('xl/workbook.xml') || '';
  const rels = zip.read('xl/_rels/workbook.xml.rels') || '';
  const relMap = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(([, attrs]) => {
    const id = (attrs.match(/\bId="([^"]+)"/) || [])[1];
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    if (!id || !target) return null;
    return [id, target.startsWith('/') ? target.replace(/^\//, '') : `xl/${target}`.replace(/\/[^/]+\/\.\.\//g, '/')];
  }).filter(Boolean));
  const named = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map(([, attrs], i) => {
    const name = decodeEntities((attrs.match(/\bname="([^"]*)"/) || [])[1] || `工作表 ${i + 1}`);
    const rid = (attrs.match(/\br:id="([^"]+)"/) || [])[1];
    const path = relMap.get(rid) || `xl/worksheets/sheet${i + 1}.xml`;
    return { name, path };
  }).filter((s) => zip.read(s.path) != null);
  if (named.length) return named;
  return zip.names()
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => sheetNo(a) - sheetNo(b))
    .map((path, i) => ({ name: `工作表 ${i + 1}`, path }));
}
function tableToText(rows) {
  return rows.map((r) => r.join('\t')).join('\n');
}
function colToIndex(col) {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}
function sheetNo(n) { return +(n.match(/sheet(\d+)\.xml$/) || [])[1] || 0; }

function odfText(zip) {
  const xml = zip.read('content.xml');
  if (xml == null) throw new Error('OpenDocument 缺少 content.xml');
  return xmlToText(xml, { para: ['text:p', 'text:h'], br: ['text:line-break'], tab: ['text:tab'] });
}

// RTF → 文字：括號感知的狀態機。跳過字體/顏色表等「目標群組」（否則它們會洩漏成文字），
// 解 \uN unicode 與 \'hh hex 跳脫，把 \par/\tab/\line 轉成換行/tab。best-effort，複雜排版會丟格式。
const RTF_DEST = /^(fonttbl|colortbl|stylesheet|info|pict|object|themedata|colorschememapping|datastore|latentstyles|listtable|listoverridetable|rsidtbl|generator|operator|company|filetbl|revtbl|xmlnstbl)$/;
function rtfToText(rtf) {
  let out = '';
  const stack = [{ skip: false }];
  const cur = () => stack[stack.length - 1];
  let i = 0; const n = rtf.length;
  let skipChars = 0; // \uN 之後要略過的替代字元數（\ucN 控制，預設 1）
  let uc = 1;
  const emit = (s) => { if (!cur().skip) out += s; };
  while (i < n) {
    const ch = rtf[i];
    if (ch === '{') { stack.push({ skip: cur().skip }); i++; continue; }
    if (ch === '}') { if (stack.length > 1) stack.pop(); i++; continue; }
    if (ch === '\\') {
      const nx = rtf[i + 1];
      if (nx === '\\' || nx === '{' || nx === '}') { emit(nx); i += 2; continue; } // 跳脫字元
      if (nx === '*') { cur().skip = true; i += 2; continue; }                       // 可忽略目標群組
      if (nx === "'") { const hex = rtf.substr(i + 2, 2); if (skipChars > 0) skipChars--; else emit(Buffer.from(hex, 'hex').toString('latin1')); i += 4; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i)); // 控制字：字母 +（可選）數字 +（可選）分隔空白
      if (m) {
        const word = m[1], num = m[2];
        if (word === 'par' || word === 'pard' || word === 'line') emit('\n');
        else if (word === 'tab') emit('\t');
        else if (word === 'uc') uc = Math.max(0, +num || 0);
        else if (word === 'u') { emit(String.fromCodePoint(((+num) + 65536) % 65536)); skipChars = uc; }
        else if (RTF_DEST.test(word)) cur().skip = true;
        i += m[0].length; continue;
      }
      i++; continue; // 落單反斜線
    }
    if (ch === '\r' || ch === '\n') { i++; continue; } // RTF 原始換行不是內容
    if (skipChars > 0) { skipChars--; i++; continue; } // \uN 的替代字元
    emit(ch); i++;
  }
  return out;
}

// PDF：純 JS 無可靠解法 → 用系統 pdftotext（poppler）。沒有就丟清楚的安裝/轉檔提示。
function extractPdf(path) {
  const r = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error('PDF 需要系統的 pdftotext（poppler）。安裝：macOS `brew install poppler`、Debian/Ubuntu `apt install poppler-utils`；或先用 bash 把 PDF 轉成文字再 read。');
  }
  return tidy(r.stdout || '');
}
