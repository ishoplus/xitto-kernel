// 文件產出（與 doc-extract 對稱：那個「讀」Office/PDF，這個「產」可交付文件）。
// 路線 A（零 npm 相依）：md → 乾淨可列印 HTML（中文用系統字體，HTML 本身即可交付）；
//   PDF = 偵測系統渲染器（Chrome headless / wkhtmltopdf / soffice）把 HTML 轉檔；無則回 HTML + 提示。
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { extractDocText } from './doc-extract.js';

const require = createRequire(import.meta.url);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const xmlEsc = escAttr;

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
  return mdTablesToRows(md)[0]?.rows || null;
}

// 取 markdown 內所有 GFM 表格；若表格前方最近一個標題存在，用作 sheet 名稱。
export function mdTablesToRows(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isSep = (s) => s.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
  const tables = [];
  let heading = '';
  for (let i = 0; i + 1 < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.+)/);
    if (h) heading = h[1].trim();
    if (lines[i].includes('|') && lines[i + 1].includes('|') && isSep(lines[i + 1])) {
      const rows = [cells(lines[i])]; let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') { rows.push(cells(lines[j])); j++; }
      tables.push({ name: heading || `Sheet${tables.length + 1}`, rows });
      i = j - 1;
    }
  }
  return tables;
}

function plainInline(s) {
  return String(s == null ? '' : s)
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1');
}

function mdBlocks(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => plainInline(c.trim()));
  const isSep = (s) => s.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
  let para = [];
  const flush = () => {
    const text = para.join(' ').trim();
    if (text) blocks.push({ type: 'paragraph', text: plainInline(text) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) { flush(); continue; }
    const h = ln.match(/^(#{1,6})\s+(.*)/);
    if (h) { flush(); blocks.push({ type: 'heading', level: h[1].length, text: plainInline(h[2]) }); continue; }
    if (ln.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && isSep(lines[i + 1])) {
      flush();
      const rows = [cells(ln)]; let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') { rows.push(cells(lines[j])); j++; }
      blocks.push({ type: 'table', rows });
      i = j - 1; continue;
    }
    const li = ln.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) { flush(); blocks.push({ type: 'bullet', text: plainInline(li[1]) }); continue; }
    if (ln.startsWith('> ')) { flush(); blocks.push({ type: 'quote', text: plainInline(ln.slice(2)) }); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) { flush(); continue; }
    para.push(ln.trim());
  }
  flush();
  return blocks;
}
// 列陣列 → CSV 字串（RFC4180 轉義：含 , " 換行 的欄位加引號、內部 " 變 ""）。
export function toCsv(rows) {
  const e = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return rows.map((r) => r.map(e).join(',')).join('\r\n');
}

function sheetName(name, used) {
  let base = String(name || 'Sheet').replace(/[:\\/?*\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let out = base, n = 2;
  while (used.has(out.toLowerCase())) {
    const suffix = ` ${n++}`;
    out = base.slice(0, Math.max(1, 31 - suffix.length)) + suffix;
  }
  used.add(out.toLowerCase());
  return out;
}
function colName(idx) {
  let n = idx + 1, out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}
function sheetRef(name) {
  return `'${String(name || 'Sheet').replace(/'/g, "''")}'`;
}
function cellAddress(r, c) {
  return `${colName(c)}${r + 1}`;
}
function parseCell(raw) {
  const s = String(raw == null ? '' : raw);
  const t = s.trim();
  if (t === '^') return { kind: 'merge-up' };
  if (t.startsWith('=')) {
    const formula = t.slice(1).trim();
    if (formula) return { kind: 'formula', formula };
  }
  return { kind: 'text', value: s };
}
function buildChartSpec(rows, name) {
  if (!Array.isArray(rows) || rows.length < 3) return null;
  const headers = rows[0].map((v) => String(v == null ? '' : v));
  const width = Math.max(...rows.map((r) => r.length));
  const numericCols = [];
  for (let c = 1; c < width; c++) {
    const vals = rows.slice(1).map((r) => String(r?.[c] ?? '').trim()).filter(Boolean);
    if (!vals.length) continue;
    const numeric = vals.filter((v) => /^-?\d+(\.\d+)?$/.test(v)).length;
    if (numeric && numeric === vals.length) numericCols.push(c);
  }
  if (!numericCols.length) return null;
  return {
    name,
    labelCol: 0,
    valueCol: numericCols[0],
    rowStart: 2,
    rowEnd: rows.length,
    title: headers[numericCols[0]] || `${name} 數值`,
  };
}
function chartFormula(spec, col, rowStart, rowEnd) {
  return `${sheetRef(spec.name)}!$${colName(col)}$${rowStart}:$${colName(col)}$${rowEnd}`;
}
function chartXml(spec) {
  const cat = chartFormula(spec, spec.labelCol, spec.rowStart, spec.rowEnd);
  const val = chartFormula(spec, spec.valueCol, spec.rowStart, spec.rowEnd);
  const titleCell = `${sheetRef(spec.name)}!$${colName(spec.valueCol)}$1`;
  const ax1 = 48650112;
  const ax2 = 48672768;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:lang val="zh-TW"/>
  <c:chart>
    <c:title>
      <c:tx>
        <c:strRef><c:f>${xmlEsc(titleCell)}</c:f></c:strRef>
      </c:tx>
      <c:layout/>
    </c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/>
        <c:varyColors val="0"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx><c:strRef><c:f>${xmlEsc(titleCell)}</c:f></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>${xmlEsc(cat)}</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>${xmlEsc(val)}</c:f></c:numRef></c:val>
        </c:ser>
        <c:gapWidth val="150"/>
        <c:axId val="${ax1}"/>
        <c:axId val="${ax2}"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="${ax1}"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="l"/>
        <c:majorGridlines/>
        <c:tickLblPos val="nextTo"/>
        <c:crossAx val="${ax2}"/>
        <c:crosses val="autoZero"/>
        <c:auto val="1"/>
        <c:lblAlgn val="ctr"/>
        <c:lblOffset val="100"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="${ax2}"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="b"/>
        <c:majorGridlines/>
        <c:numFmt formatCode="General" sourceLinked="1"/>
        <c:tickLblPos val="nextTo"/>
        <c:crossAx val="${ax1}"/>
        <c:crosses val="autoZero"/>
        <c:crossBetween val="between"/>
      </c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="r"/></c:legend>
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
  </c:chart>
</c:chartSpace>`;
}
function drawingXml(chartName, startRow = 0) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${startRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${startRow + 18}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame>
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="2" name="${xmlEsc(chartName)}"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;
}
function drawingRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`;
}
function sheetRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
}
function sheetXml(rows, { chart = false } = {}) {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => {
    const max = Math.max(8, ...rows.map((r) => {
      const cell = parseCell(r[i]);
      return cell.kind === 'formula' ? 12 : String(r[i] || '').length;
    }));
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(40, max + 2)}" customWidth="1"/>`;
  }).join('');
  const merges = [];
  const body = rows.map((row, r) => '<row r="' + (r + 1) + '">' + Array.from({ length: width }, (_, c) => {
    const cell = parseCell(row[c]);
    if (cell.kind === 'merge-up') {
      if (r > 0) merges.push(`<mergeCell ref="${cellAddress(r - 1, c)}:${cellAddress(r, c)}"/>`);
      return '';
    }
    if (cell.kind === 'formula') {
      return `<c r="${cellAddress(r, c)}" s="${r === 0 ? 2 : 1}"><f>${xmlEsc(cell.formula)}</f><v></v></c>`;
    }
    const v = cell.value.trim ? cell.value.trim() : String(cell.value || '');
    if (!v) return '';
    return `<c r="${cellAddress(r, c)}" t="inlineStr" s="${r === 0 ? 1 : 0}"><is><t>${xmlEsc(v)}</t></is></c>`;
  }).join('') + '</row>').join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cols>${cols}</cols><sheetData>${body}</sheetData>${merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : ''}${chart ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
}
function workbookXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
}
function workbookRels(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}
function contentTypes(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${sheets[i].chart ? `<Override PartName="/xl/worksheets/_rels/sheet${i + 1}.xml.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/drawings/_rels/drawing${i + 1}.xml.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>` : ''}`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
}
const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b val="1"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF2FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(local, 30);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42); nameBuf.copy(central, 46);
    const localFull = Buffer.concat([local, data]);
    locals.push(localFull); centrals.push(central); offset += localFull.length;
  }
  const localAll = Buffer.concat(locals), cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(localAll.length, 16);
  return Buffer.concat([localAll, cd, eocd]);
}
function writeXlsxFromTables(tables, outPath) {
  const used = new Set();
  const sheets = tables.map((t, i) => {
    const name = sheetName(t.name || `Sheet${i + 1}`, used);
    const chart = buildChartSpec(t.rows, name);
    return { name, rows: t.rows, chart };
  });
  const files = [
    { name: '[Content_Types].xml', data: contentTypes(sheets) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(sheets) },
    { name: 'xl/styles.xml', data: XLSX_STYLES },
    ...sheets.flatMap((s, i) => {
      const sheetFiles = [{ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, { chart: Boolean(s.chart) }) }];
      if (s.chart) {
        sheetFiles.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: sheetRelsXml() });
        sheetFiles.push({ name: `xl/drawings/drawing${i + 1}.xml`, data: drawingXml(`${s.name} 圖表`, s.rows.length + 2) });
        sheetFiles.push({ name: `xl/drawings/_rels/drawing${i + 1}.xml.rels`, data: drawingRelsXml() });
        sheetFiles.push({ name: `xl/charts/chart${i + 1}.xml`, data: chartXml(s.chart) });
      }
      return sheetFiles;
    }),
  ];
  const buf = zipStore(files);
  writeFileSync(outPath, buf);
  return { bytes: buf.length, sheets: sheets.length, rows: sheets.reduce((n, s) => n + s.rows.length, 0) };
}

function hasPackage(name) {
  try { require.resolve(name); return true; } catch { return false; }
}

function docxParagraph(block, api) {
  const { HeadingLevel, Paragraph, TextRun } = api;
  if (block.type === 'heading') {
    const heading = block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
    return new Paragraph({ text: block.text, heading, spacing: { after: 180 } });
  }
  if (block.type === 'bullet') return new Paragraph({ text: block.text, bullet: { level: 0 }, spacing: { after: 80 } });
  if (block.type === 'quote') return new Paragraph({ children: [new TextRun({ text: block.text, italics: true })], indent: { left: 360 }, spacing: { after: 120 } });
  return new Paragraph({ text: block.text || '', spacing: { after: 120 } });
}

async function renderMarkdownToDocx(markdown, outPath, { title = '' } = {}) {
  const api = await import('docx');
  const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = api;
  const children = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 260 } }));
  for (const block of mdBlocks(markdown)) {
    if (block.type === 'table') {
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: block.rows.map((row) => new TableRow({
          children: row.map((cell) => new TableCell({
            children: [new Paragraph({ children: [new TextRun(String(cell || ''))] })],
          })),
        })),
      }));
      children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
    } else {
      children.push(docxParagraph(block, api));
    }
  }
  if (!children.length) children.push(new Paragraph({ text: '' }));
  const doc = new Document({
    creator: 'xitto-kernel',
    title: title || '文件',
    sections: [{ properties: {}, children }],
  });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(outPath, buf);
  return { ok: isZip(outPath), tool: 'docx-native' };
}

function pptxSections(markdown) {
  const blocks = mdBlocks(markdown);
  const sections = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === 'heading' && b.level === 1) {
      if (cur) sections.push(cur);
      cur = { title: b.text, blocks: [] };
    } else {
      if (!cur) cur = { title: '簡報', blocks: [] };
      cur.blocks.push(b);
    }
  }
  if (cur) sections.push(cur);
  return sections.length ? sections : [{ title: '簡報', blocks: [{ type: 'paragraph', text: String(markdown || '').trim() }] }];
}

async function renderMarkdownToPptx(markdown, outPath, { title = '' } = {}) {
  const mod = await import('pptxgenjs');
  const PptxGenJS = mod.default || mod;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'xitto-kernel';
  pptx.subject = title || '簡報';
  pptx.title = title || '簡報';
  pptx.company = 'xitto-kernel';
  const deck = markdownToDeckSpec(markdown, { title: title || '簡報' });
  renderDeckSpec(pptx, deck);
  await pptx.writeFile({ fileName: outPath });
  return { ok: isZip(outPath), tool: 'pptx-native', slides: deck.slides.length };
}

function markdownToDeckSpec(markdown, { title = '簡報' } = {}) {
  const sections = pptxSections(markdown);
  const slides = [];
  sections.forEach((sec, secIndex) => {
    const normalized = normalizeDeckSection(sec);
    if (secIndex === 0 && normalized.shortIntro && !normalized.tables.length && normalized.bullets.length <= 3) {
      slides.push({ type: 'cover', title: normalized.title || title, subtitle: normalized.shortIntro });
    }
    if (normalized.bullets.length) {
      splitBullets(normalized.bullets).forEach((bullets, i) => {
        slides.push({
          type: bullets.length <= 3 && normalized.shortIntro && i === 0 ? 'statement' : 'bullets',
          title: i === 0 ? normalized.title : continuationDeckTitle(normalized.title, i + 1),
          subtitle: i === 0 ? normalized.shortIntro : '',
          bullets,
        });
      });
    }
    normalized.diagrams.forEach((diagram) => {
      slides.push({
        type: diagram.type,
        title: diagram.title || normalized.title,
        subtitle: normalized.shortIntro,
        items: diagram.items,
        rows: diagram.rows,
      });
    });
    normalized.tables.forEach((table) => {
      splitTableRows(table.rows).forEach((rows, i) => {
        slides.push({
          type: 'table',
          title: i === 0 ? normalized.title : continuationDeckTitle(normalized.title, i + 1),
          subtitle: table.name || '',
          rows,
        });
      });
    });
    if (!normalized.bullets.length && !normalized.tables.length && !normalized.diagrams.length && !slides.some((s) => s.title === normalized.title)) {
      slides.push({ type: 'statement', title: normalized.title || title, subtitle: normalized.shortIntro, bullets: [] });
    }
  });
  if (!slides.length) slides.push({ type: 'cover', title, subtitle: '' });
  return {
    theme: {
      accent: '245B8F',
      accent2: '0F766E',
      accent3: 'D97706',
      ink: '111827',
      muted: '4B5563',
      soft: 'EEF5FA',
      wash: 'F8FAFC',
      panel: 'FFFFFF',
      line: 'D7DEE8',
    },
    slides: slides.slice(0, 40),
  };
}

export function planPptxDeck(markdown, { title = '簡報' } = {}) {
  const deck = markdownToDeckSpec(markdown, { title });
  const unsupportedIntents = unsupportedDiagramIntents(markdown);
  const slides = deck.slides.map((slide, i) => ({
    index: i + 1,
    type: slide.type,
    title: slide.title || '',
    bullets: Array.isArray(slide.bullets) ? slide.bullets.length : 0,
    tableRows: Array.isArray(slide.rows) ? slide.rows.length : 0,
    items: Array.isArray(slide.items) ? slide.items.length : 0,
  }));
  const diagramTypes = [...new Set(slides.map((s) => s.type).filter((t) => SUPPORTED_DECK_DIAGRAMS.includes(t)))];
  const warnings = [];
  if (slides.length >= DECK_CONTRACT.maxSlides) warnings.push({ code: 'slide-cap-reached', message: `簡報已達 ${DECK_CONTRACT.maxSlides} 頁上限，後續內容可能被截斷` });
  slides.forEach((s) => {
    if (s.bullets > DECK_CONTRACT.maxBulletsPerSlide) warnings.push({ code: 'too-many-bullets', slide: s.index, message: '單頁 bullet 超過契約上限' });
    if (s.tableRows > DECK_CONTRACT.maxTableRowsPerSlide) warnings.push({ code: 'too-many-table-rows', slide: s.index, message: '單頁表格列數超過契約上限' });
  });
  unsupportedIntents.forEach((x) => warnings.push({
    code: 'unsupported-diagram-heading',
    heading: x.heading,
    section: x.section,
    message: `「${x.heading}」看起來是圖解需求，但不在受控圖解契約內；請改用 supportedDiagrams，或先新增 renderer、文檔與回歸測試。`,
  }));
  return {
    kind: 'pptx-deck-plan',
    title,
    contract: DECK_CONTRACT,
    summary: {
      slides: slides.length,
      diagrams: diagramTypes,
      tables: slides.filter((s) => s.type === 'table').length,
      contentSlides: slides.filter((s) => !['cover'].includes(s.type)).length,
      unsupportedDiagramIntents: unsupportedIntents.length,
      warnings: warnings.length,
    },
    slides,
    warnings,
  };
}

const SUPPORTED_DECK_DIAGRAMS = ['timeline', 'cycle', 'funnel', 'pyramid', 'swot', 'org', 'gantt', 'venn', 'radar', 'architecture', 'dashboard', 'flow', 'fishbone', 'matrix'];
const DECK_CONTRACT = {
  renderer: 'pptx-native-controlled-deck',
  llmRole: 'content-structure-only',
  maxSlides: 40,
  maxBulletsPerSlide: 5,
  maxTableRowsPerSlide: 8,
  unsupported: ['manual coordinates', 'custom shape syntax', 'absolute positioning from LLM'],
  supportedDiagrams: SUPPORTED_DECK_DIAGRAMS,
};

function unsupportedDiagramIntents(markdown) {
  const out = [];
  pptxSections(markdown).forEach((sec) => {
    (sec.blocks || []).forEach((b) => {
      if (b.type !== 'heading' || b.level !== 2) return;
      const heading = String(b.text || '').trim();
      if (!heading || diagramTypeFromHeading(heading)) return;
      if (looksLikeDiagramHeading(heading)) out.push({ section: sec.title || '', heading });
    });
  });
  return out;
}

function looksLikeDiagramHeading(text) {
  const s = String(text || '').toLowerCase();
  return /圖|图|diagram|chart|架構|架构|泳道|swimlane|桑基|sankey|關係|关系|network|拓撲|拓扑|樹狀|树状|tree|mind\s*map|心智圖|心智图/.test(s);
}

function normalizeDeckSection(sec) {
  const bullets = [];
  const tables = [];
  const diagrams = [];
  const intros = [];
  let diagram = null;
  const flushDiagram = () => {
    if (!diagram) return;
    if (diagram.items.length || diagram.rows.length) diagrams.push(diagram);
    diagram = null;
  };
  for (const b of sec.blocks || []) {
    if (b.type === 'heading' && b.level === 2) {
      flushDiagram();
      const type = diagramTypeFromHeading(b.text);
      if (type) diagram = { type, title: b.text, items: [], rows: [] };
      else bullets.push(String(b.text || ''));
      continue;
    }
    if (diagram && b.type === 'bullet') diagram.items.push(...splitLongBullet(b.text));
    else if (diagram && b.type === 'table') diagram.rows.push(...b.rows);
    else if (b.type === 'bullet') bullets.push(...splitLongBullet(b.text));
    else if (b.type === 'table') tables.push({ name: '', rows: b.rows });
    else if (b.type === 'heading') bullets.push(String(b.text || ''));
    else if (b.text) intros.push(String(b.text || ''));
  }
  flushDiagram();
  return {
    title: shortenDeckText(sec.title || '簡報', 42),
    shortIntro: shortenDeckText(intros.join(' '), 96),
    bullets,
    tables,
    diagrams,
  };
}

function diagramTypeFromHeading(text) {
  const s = String(text || '').toLowerCase();
  if (/時間線|时序|時序|timeline|roadmap|里程碑|milestone/.test(s)) return 'timeline';
  if (/循環|循环|cycle|closed loop|pdca/.test(s)) return 'cycle';
  if (/漏斗|funnel|轉化|转化|conversion/.test(s)) return 'funnel';
  if (/金字塔|pyramid|層級|层级|hierarchy/.test(s)) return 'pyramid';
  if (/swot/.test(s)) return 'swot';
  if (/系統架構|系统架构|architecture|模組|模块|module/.test(s)) return 'architecture';
  if (/組織架構|组织架构|組織圖|组织图|org chart|org|organization/.test(s)) return 'org';
  if (/甘特|gantt|排期|schedule/.test(s)) return 'gantt';
  if (/venn|交集|重疊|重叠|集合/.test(s)) return 'venn';
  if (/雷達|雷达|radar|能力評估|能力评估/.test(s)) return 'radar';
  if (/kpi|dashboard|儀表|仪表|看板|指標看板|指标看板/.test(s)) return 'dashboard';
  if (/流程|flow|process|roadmap/.test(s)) return 'flow';
  if (/魚骨|鱼骨|fishbone|ishikawa|cause/.test(s)) return 'fishbone';
  if (/矩陣|矩阵|matrix|比較|对比|compare|comparison/.test(s)) return 'matrix';
  return '';
}

function splitLongBullet(text) {
  const s = String(text || '').trim();
  if (textLengthForDeck(s) <= 48) return [s].filter(Boolean);
  const parts = s.split(/[，,；;。]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return [shortenDeckText(s, 72)];
  return parts.map((p) => shortenDeckText(p, 56)).filter(Boolean);
}

function splitBullets(bullets) {
  const clean = bullets.map((b) => shortenDeckText(b, 72)).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < clean.length; i += 5) chunks.push(clean.slice(i, i + 5));
  return chunks.length ? chunks : [[]];
}

function splitTableRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const [header, ...body] = rows;
  const chunks = [];
  for (let i = 0; i < body.length; i += 7) chunks.push([header, ...body.slice(i, i + 7)]);
  return chunks.length ? chunks : [rows.slice(0, 8)];
}

function continuationDeckTitle(title, n) {
  const suffix = `（續 ${n}）`;
  return `${[...String(title || '投影片')].slice(0, Math.max(1, 42 - textLengthForDeck(suffix))).join('')}${suffix}`;
}

function shortenDeckText(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return textLengthForDeck(s) > max ? `${[...s].slice(0, Math.max(1, max - 3)).join('')}...` : s;
}

function textLengthForDeck(s) {
  return [...String(s || '')].length;
}

function renderDeckSpec(pptx, deck) {
  deck.slides.forEach((spec, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: deck.theme.wash };
    addDeckChrome(pptx, slide, deck.theme, i + 1, deck.slides.length);
    if (spec.type === 'cover') renderCoverSlide(slide, spec, deck.theme);
    else if (spec.type === 'timeline') renderTimelineSlide(slide, spec, deck.theme);
    else if (spec.type === 'cycle') renderCycleSlide(pptx, slide, spec, deck.theme);
    else if (spec.type === 'funnel') renderFunnelSlide(slide, spec, deck.theme);
    else if (spec.type === 'pyramid') renderPyramidSlide(slide, spec, deck.theme);
    else if (spec.type === 'swot') renderSwotSlide(slide, spec, deck.theme);
    else if (spec.type === 'org') renderOrgSlide(slide, spec, deck.theme);
    else if (spec.type === 'gantt') renderGanttSlide(slide, spec, deck.theme);
    else if (spec.type === 'venn') renderVennSlide(slide, spec, deck.theme);
    else if (spec.type === 'radar') renderRadarSlide(slide, spec, deck.theme);
    else if (spec.type === 'architecture') renderArchitectureSlide(slide, spec, deck.theme);
    else if (spec.type === 'dashboard') renderDashboardSlide(slide, spec, deck.theme);
    else if (spec.type === 'flow') renderFlowSlide(pptx, slide, spec, deck.theme);
    else if (spec.type === 'fishbone') renderFishboneSlide(pptx, slide, spec, deck.theme);
    else if (spec.type === 'matrix') renderMatrixSlide(slide, spec, deck.theme);
    else if (spec.type === 'table') renderTableSlide(slide, spec, deck.theme);
    else if (spec.type === 'statement') renderStatementSlide(slide, spec, deck.theme);
    else renderBulletSlide(slide, spec, deck.theme);
  });
}

function addDeckChrome(pptx, slide, theme, _no, _total) {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.14, h: 7.5, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addShape(pptx.ShapeType.rect, { x: 0.14, y: 0, w: 13.19, h: 0.13, fill: { color: 'E8EEF6' }, line: { color: 'E8EEF6' } });
  slide.addShape(pptx.ShapeType.rect, { x: 0.62, y: 1.03, w: 2.6, h: 0.05, fill: { color: theme.accent2 }, line: { color: theme.accent2 } });
}

function renderDeckTitle(slide, title, theme, opts = {}) {
  slide.addText(shortenDeckText(title, 42), {
    x: 0.58, y: opts.y ?? 0.32, w: 11.7, h: opts.h ?? 0.55,
    fontFace: 'Aptos Display', fontSize: opts.size ?? 27, bold: true, color: theme.ink,
    margin: 0, fit: 'shrink',
  });
}

function renderCoverSlide(slide, spec, theme) {
  slide.addShape('rect', { x: 8.35, y: 0.13, w: 4.98, h: 7.37, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addShape('rect', { x: 9.18, y: 0.95, w: 2.85, h: 5.35, fill: { color: 'FFFFFF', transparency: 88 }, line: { color: 'FFFFFF', transparency: 100 } });
  slide.addShape('rect', { x: 9.82, y: 1.45, w: 2.15, h: 3.25, fill: { color: theme.accent2, transparency: 18 }, line: { color: theme.accent2, transparency: 100 } });
  slide.addShape('rect', { x: 0.72, y: 1.55, w: 1.15, h: 0.08, fill: { color: theme.accent3 }, line: { color: theme.accent3 } });
  slide.addText('Executive deck', { x: 0.72, y: 1.18, w: 2.3, h: 0.26, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 1.2 });
  slide.addText(shortenDeckText(spec.title, 46), { x: 0.72, y: 2.02, w: 7.0, h: 1.18, fontFace: 'Aptos Display', fontSize: 36, bold: true, color: theme.ink, margin: 0, breakLine: false, fit: 'shrink' });
  if (spec.subtitle) slide.addText(shortenDeckText(spec.subtitle, 120), { x: 0.76, y: 3.45, w: 6.8, h: 0.76, fontFace: 'Aptos', fontSize: 16.5, color: theme.muted, margin: 0.02, fit: 'shrink' });
  slide.addShape('rect', { x: 0.72, y: 5.35, w: 4.9, h: 0.62, fill: { color: 'FFFFFF' }, line: { color: theme.line, transparency: 25 } });
  slide.addText('Generated with controlled layout', { x: 0.96, y: 5.55, w: 4.25, h: 0.2, fontFace: 'Aptos', fontSize: 10.5, color: theme.muted, margin: 0 });
}

function renderStatementSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  slide.addShape('rect', { x: 0.72, y: 1.6, w: 11.25, h: 4.8, fill: { color: theme.panel }, line: { color: theme.line, transparency: 30 } });
  slide.addShape('rect', { x: 0.72, y: 1.6, w: 0.16, h: 4.8, fill: { color: theme.accent2 }, line: { color: theme.accent2 } });
  if (spec.subtitle) slide.addText(shortenDeckText(spec.subtitle, 140), { x: 1.15, y: 2.0, w: 9.6, h: 0.95, fontFace: 'Aptos Display', fontSize: 22, bold: true, color: theme.accent, margin: 0.02, fit: 'shrink' });
  if (spec.bullets?.length) addBullets(slide, spec.bullets, { x: 1.18, y: 3.25, w: 9.95, h: 2.35 }, theme, 17.5);
}

function renderBulletSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  if (spec.subtitle) slide.addText(shortenDeckText(spec.subtitle, 96), { x: 0.82, y: 1.18, w: 10.6, h: 0.42, fontFace: 'Aptos', fontSize: 12.5, color: theme.muted, margin: 0, fit: 'shrink' });
  const bullets = (spec.bullets || []).slice(0, 5).map((t) => shortenDeckText(t, 72));
  slide.addShape('rect', { x: 0.72, y: 1.72, w: 2.55, h: 4.92, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText('Key points', { x: 1.02, y: 2.04, w: 1.8, h: 0.3, fontFace: 'Aptos', fontSize: 11, bold: true, color: 'FFFFFF', margin: 0, charSpace: 0.8 });
  slide.addText(String(Math.max(1, bullets.length)).padStart(2, '0'), { x: 1.0, y: 2.48, w: 1.25, h: 0.62, fontFace: 'Aptos Display', fontSize: 33, bold: true, color: 'FFFFFF', margin: 0 });
  slide.addShape('rect', { x: 1.02, y: 3.32, w: 1.38, h: 0.06, fill: { color: theme.accent3 }, line: { color: theme.accent3 } });
  bullets.forEach((text, i) => addPointCard(slide, text, i, theme));
}

function addPointCard(slide, text, i, theme) {
  const y = 1.72 + i * 0.94;
  const color = i % 2 === 0 ? 'FFFFFF' : theme.soft;
  slide.addShape('rect', { x: 3.55, y, w: 8.35, h: 0.74, fill: { color }, line: { color: theme.line, transparency: 25 } });
  slide.addShape('rect', { x: 3.55, y, w: 0.08, h: 0.74, fill: { color: i === 0 ? theme.accent3 : theme.accent2 }, line: { color: i === 0 ? theme.accent3 : theme.accent2 } });
  slide.addText(`0${i + 1}`, { x: 3.82, y: y + 0.18, w: 0.45, h: 0.2, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent, margin: 0 });
  slide.addText(text, { x: 4.36, y: y + 0.14, w: 6.95, h: 0.34, fontFace: 'Aptos', fontSize: 13.6, color: theme.ink, margin: 0, fit: 'shrink' });
}

function addBullets(slide, bullets, box, theme, fontSize) {
  const safe = bullets.slice(0, 5).map((t) => shortenDeckText(t, 72));
  if (!safe.length) return;
  slide.addText(safe.map((text) => ({ text, options: { bullet: { type: 'bullet' } } })), {
    ...box,
    fontFace: 'Aptos', fontSize, color: theme.muted,
    breakLine: false, fit: 'shrink', margin: 0.04,
    paraSpaceAfterPt: 7,
  });
}

function renderTableSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  if (spec.subtitle) slide.addText(shortenDeckText(spec.subtitle, 72), { x: 0.82, y: 1.16, w: 10.6, h: 0.35, fontFace: 'Aptos', fontSize: 12, color: theme.muted, margin: 0 });
  const rows = (spec.rows || []).slice(0, 8).map((row) => row.map((cell) => shortenDeckText(cell, 36)));
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 25 } });
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 0.48, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText('Data table', { x: 0.96, y: 1.78, w: 1.8, h: 0.18, fontFace: 'Aptos', fontSize: 9.5, bold: true, color: 'FFFFFF', margin: 0, charSpace: 0.7 });
  slide.addTable(rows, {
    x: 0.92, y: 2.32, w: 10.85, h: Math.min(3.85, Math.max(0.8, rows.length * 0.42)),
    border: { type: 'solid', color: theme.line, pt: 0.75 },
    fontFace: 'Aptos', fontSize: 11.5, color: theme.ink,
    fill: 'F8FAFC', margin: 0.06, autoFit: true,
    valign: 'mid',
    rowH: 0.42,
    autoPage: false,
  });
}

function renderFlowSlide(pptx, slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  if (spec.subtitle) slide.addText(shortenDeckText(spec.subtitle, 92), { x: 0.82, y: 1.14, w: 10.6, h: 0.34, fontFace: 'Aptos', fontSize: 12, color: theme.muted, margin: 0 });
  const items = (spec.items || []).slice(0, 5).map((x) => shortenDeckText(x, 42));
  const y = 2.25;
  const w = 1.86;
  const gap = 0.34;
  slide.addShape('rect', { x: 0.72, y: 1.72, w: 11.25, h: 4.82, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  items.forEach((item, i) => {
    const x = 1.02 + i * (w + gap);
    slide.addShape('rect', { x, y, w, h: 1.28, fill: { color: i % 2 ? theme.soft : 'FFFFFF' }, line: { color: theme.line, transparency: 22 } });
    slide.addShape('rect', { x, y, w, h: 0.24, fill: { color: i === 0 ? theme.accent3 : theme.accent }, line: { color: i === 0 ? theme.accent3 : theme.accent } });
    slide.addText(`0${i + 1}`, { x: x + 0.18, y: y + 0.43, w: 0.42, h: 0.22, fontFace: 'Aptos', fontSize: 10, bold: true, color: theme.accent, margin: 0 });
    slide.addText(item, { x: x + 0.18, y: y + 0.72, w: w - 0.34, h: 0.36, fontFace: 'Aptos', fontSize: 12, bold: true, color: theme.ink, margin: 0, fit: 'shrink' });
    if (i < items.length - 1) {
      slide.addShape(pptx.ShapeType.chevron, { x: x + w + 0.07, y: y + 0.43, w: 0.27, h: 0.42, fill: { color: theme.accent2 }, line: { color: theme.accent2 } });
    }
  });
  slide.addText('Process flow', { x: 1.02, y: 4.55, w: 2.5, h: 0.28, fontFace: 'Aptos', fontSize: 11, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function renderFishboneSlide(pptx, slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const items = (spec.items || []).slice(0, 6).map((x) => shortenDeckText(x, 38));
  const midY = 3.86;
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  slide.addShape('line', { x: 1.25, y: midY, w: 8.9, h: 0, line: { color: theme.accent, pt: 2.4, beginArrowType: 'none', endArrowType: 'triangle' } });
  slide.addText('Core effect', { x: 10.22, y: midY - 0.28, w: 1.35, h: 0.35, fontFace: 'Aptos', fontSize: 11.5, bold: true, color: theme.accent, margin: 0, fit: 'shrink' });
  items.forEach((item, i) => {
    const upper = i % 2 === 0;
    const col = Math.floor(i / 2);
    const x = 2.05 + col * 2.45;
    const y2 = upper ? 2.38 : 5.18;
    addDeckLine(slide, x, midY, x + 1.18, upper ? midY - 0.86 : midY + 0.86, { color: theme.accent2, pt: 1.6 });
    slide.addShape('rect', { x: x - 0.35, y: y2, w: 2.08, h: 0.58, fill: { color: upper ? theme.soft : 'FFFFFF' }, line: { color: theme.line, transparency: 20 } });
    slide.addShape('rect', { x: x - 0.35, y: y2, w: 0.08, h: 0.58, fill: { color: upper ? theme.accent2 : theme.accent3 }, line: { color: upper ? theme.accent2 : theme.accent3 } });
    slide.addText(item, { x: x - 0.18, y: y2 + 0.14, w: 1.65, h: 0.22, fontFace: 'Aptos', fontSize: 10.8, bold: true, color: theme.ink, margin: 0, fit: 'shrink' });
  });
  slide.addText('Fishbone analysis', { x: 1.02, y: 1.9, w: 2.7, h: 0.24, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.7 });
}

function renderMatrixSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const rows = (spec.rows?.length ? spec.rows : matrixRowsFromItems(spec.items || [])).slice(0, 5).map((row) => row.map((cell) => shortenDeckText(cell, 34)));
  const cols = Math.max(2, Math.min(4, Math.max(0, ...rows.map((r) => r.length))));
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  const startX = 0.98;
  const startY = 2.04;
  const cellW = 10.7 / cols;
  const cellH = 0.78;
  rows.forEach((row, r) => {
    for (let c = 0; c < cols; c++) {
      const header = r === 0;
      const x = startX + c * cellW;
      const y = startY + r * cellH;
      slide.addShape('rect', { x, y, w: cellW - 0.05, h: cellH - 0.05, fill: { color: header ? theme.accent : (r + c) % 2 ? theme.soft : 'FFFFFF' }, line: { color: theme.line, transparency: 25 } });
      slide.addText(row[c] || '', { x: x + 0.12, y: y + 0.2, w: cellW - 0.32, h: 0.26, fontFace: 'Aptos', fontSize: header ? 11 : 10.5, bold: header, color: header ? 'FFFFFF' : theme.ink, margin: 0, fit: 'shrink' });
    }
  });
  slide.addText('Comparison matrix', { x: 0.98, y: 5.95, w: 2.7, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.7 });
}

function matrixRowsFromItems(items) {
  const clean = items.map(String).filter(Boolean);
  const rows = [['項目', '說明']];
  for (let i = 0; i < clean.length; i += 2) rows.push([clean[i], clean[i + 1] || '']);
  return rows;
}

function renderTimelineSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const items = diagramItems(spec).slice(0, 6).map((x) => shortenDeckText(x, 34));
  const y = 3.62;
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  slide.addShape('line', { x: 1.1, y, w: 10.25, h: 0, line: { color: theme.accent, pt: 2.2 } });
  items.forEach((item, i) => {
    const x = 1.1 + i * (10.25 / Math.max(1, items.length - 1));
    const top = i % 2 === 0;
    slide.addShape('ellipse', { x: x - 0.11, y: y - 0.11, w: 0.22, h: 0.22, fill: { color: i === 0 ? theme.accent3 : theme.accent2 }, line: { color: 'FFFFFF', pt: 1 } });
    addDeckLine(slide, x, y, x, top ? y - 0.72 : y + 0.72, { color: theme.line, pt: 1.2 });
    slide.addShape('rect', { x: x - 0.78, y: top ? y - 1.45 : y + 0.88, w: 1.56, h: 0.55, fill: { color: top ? theme.soft : 'FFFFFF' }, line: { color: theme.line, transparency: 22 } });
    slide.addText(item, { x: x - 0.64, y: top ? y - 1.3 : y + 1.04, w: 1.28, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.ink, align: 'center', margin: 0, fit: 'shrink' });
  });
  slide.addText('Timeline', { x: 0.98, y: 1.92, w: 1.7, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function renderCycleSlide(pptx, slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const items = diagramItems(spec).slice(0, 4).map((x) => shortenDeckText(x, 34));
  const boxes = [
    { x: 1.25, y: 2.0 }, { x: 7.95, y: 2.0 },
    { x: 7.95, y: 4.9 }, { x: 1.25, y: 4.9 },
  ];
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  items.forEach((item, i) => {
    const b = boxes[i];
    slide.addShape('rect', { x: b.x, y: b.y, w: 2.6, h: 0.86, fill: { color: i % 2 ? theme.soft : 'FFFFFF' }, line: { color: theme.line, transparency: 20 } });
    slide.addShape('rect', { x: b.x, y: b.y, w: 0.12, h: 0.86, fill: { color: i === 0 ? theme.accent3 : theme.accent2 }, line: { color: i === 0 ? theme.accent3 : theme.accent2 } });
    slide.addText(`0${i + 1}`, { x: b.x + 0.3, y: b.y + 0.18, w: 0.42, h: 0.2, fontFace: 'Aptos', fontSize: 10, bold: true, color: theme.accent, margin: 0 });
    slide.addText(item, { x: b.x + 0.76, y: b.y + 0.18, w: 1.55, h: 0.28, fontFace: 'Aptos', fontSize: 11.4, bold: true, color: theme.ink, margin: 0, fit: 'shrink' });
  });
  slide.addShape(pptx.ShapeType.chevron, { x: 4.8, y: 2.16, w: 0.8, h: 0.52, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addShape(pptx.ShapeType.chevron, { x: 9.04, y: 3.5, w: 0.52, h: 0.72, rotate: 90, fill: { color: theme.accent2 }, line: { color: theme.accent2 } });
  slide.addShape(pptx.ShapeType.chevron, { x: 4.8, y: 5.06, w: 0.8, h: 0.52, rotate: 180, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addShape(pptx.ShapeType.chevron, { x: 2.0, y: 3.5, w: 0.52, h: 0.72, rotate: 270, fill: { color: theme.accent2 }, line: { color: theme.accent2 } });
  slide.addText('Cycle', { x: 5.25, y: 3.38, w: 1.3, h: 0.28, fontFace: 'Aptos', fontSize: 13, bold: true, color: theme.accent, align: 'center', margin: 0 });
}

function renderFunnelSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const items = diagramItems(spec).slice(0, 5).map((x) => shortenDeckText(x, 36));
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  items.forEach((item, i) => {
    const w = 8.8 - i * 1.15;
    const x = 2.05 + i * 0.58;
    const y = 1.95 + i * 0.78;
    const color = [theme.accent, '2F6F9F', theme.accent2, 'A67C2A', theme.accent3][i] || theme.accent;
    slide.addShape('rect', { x, y, w, h: 0.56, fill: { color }, line: { color } });
    slide.addText(item, { x: x + 0.18, y: y + 0.16, w: w - 0.36, h: 0.18, fontFace: 'Aptos', fontSize: 10.8, bold: true, color: 'FFFFFF', align: 'center', margin: 0, fit: 'shrink' });
  });
  slide.addText('Funnel', { x: 0.98, y: 5.95, w: 1.6, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function renderPyramidSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const items = diagramItems(spec).slice(0, 5).map((x) => shortenDeckText(x, 38));
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  const levels = [...items].reverse();
  levels.forEach((item, i) => {
    const w = 3.0 + i * 1.45;
    const x = 6.35 - w / 2;
    const y = 2.05 + i * 0.74;
    const color = [theme.accent3, 'B8860B', theme.accent2, '2F6F9F', theme.accent][i] || theme.accent;
    slide.addShape('rect', { x, y, w, h: 0.56, fill: { color }, line: { color } });
    slide.addText(item, { x: x + 0.2, y: y + 0.15, w: w - 0.4, h: 0.2, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: 'FFFFFF', align: 'center', margin: 0, fit: 'shrink' });
  });
  slide.addText('Pyramid', { x: 0.98, y: 5.95, w: 1.8, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function renderSwotSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const buckets = swotBuckets(spec);
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  const cells = [
    { key: 'S', label: 'Strengths', x: 1.0, y: 1.98, color: theme.accent },
    { key: 'W', label: 'Weaknesses', x: 6.45, y: 1.98, color: theme.accent3 },
    { key: 'O', label: 'Opportunities', x: 1.0, y: 4.12, color: theme.accent2 },
    { key: 'T', label: 'Threats', x: 6.45, y: 4.12, color: '7C3AED' },
  ];
  cells.forEach((cell) => {
    slide.addShape('rect', { x: cell.x, y: cell.y, w: 5.0, h: 1.78, fill: { color: 'FFFFFF' }, line: { color: theme.line, transparency: 20 } });
    slide.addShape('rect', { x: cell.x, y: cell.y, w: 0.42, h: 1.78, fill: { color: cell.color }, line: { color: cell.color } });
    slide.addText(cell.key, { x: cell.x + 0.1, y: cell.y + 0.18, w: 0.22, h: 0.2, fontFace: 'Aptos', fontSize: 11, bold: true, color: 'FFFFFF', margin: 0 });
    slide.addText(cell.label, { x: cell.x + 0.62, y: cell.y + 0.18, w: 3.8, h: 0.2, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: cell.color, margin: 0 });
    slide.addText((buckets[cell.key] || []).slice(0, 3).map((x) => `• ${shortenDeckText(x, 28)}`).join('\n'), { x: cell.x + 0.62, y: cell.y + 0.56, w: 3.95, h: 0.72, fontFace: 'Aptos', fontSize: 10.2, color: theme.ink, margin: 0.02, fit: 'shrink' });
  });
}

function renderDashboardSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const metrics = dashboardMetrics(spec).slice(0, 6);
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  metrics.forEach((m, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 1.0 + col * 3.55;
    const y = 2.0 + row * 2.08;
    slide.addShape('rect', { x, y, w: 3.15, h: 1.42, fill: { color: i % 2 ? theme.soft : 'FFFFFF' }, line: { color: theme.line, transparency: 22 } });
    slide.addShape('rect', { x, y, w: 3.15, h: 0.12, fill: { color: i === 0 ? theme.accent3 : theme.accent }, line: { color: i === 0 ? theme.accent3 : theme.accent } });
    slide.addText(shortenDeckText(m.label, 22), { x: x + 0.22, y: y + 0.34, w: 2.5, h: 0.2, fontFace: 'Aptos', fontSize: 10, bold: true, color: theme.muted, margin: 0, fit: 'shrink' });
    slide.addText(shortenDeckText(m.value, 16), { x: x + 0.22, y: y + 0.72, w: 1.9, h: 0.38, fontFace: 'Aptos Display', fontSize: 22, bold: true, color: theme.accent, margin: 0, fit: 'shrink' });
    if (m.note) slide.addText(shortenDeckText(m.note, 24), { x: x + 2.04, y: y + 0.78, w: 0.86, h: 0.2, fontFace: 'Aptos', fontSize: 9.5, bold: true, color: theme.accent2, align: 'right', margin: 0, fit: 'shrink' });
  });
  slide.addText('KPI dashboard', { x: 0.98, y: 5.95, w: 2.4, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function diagramItems(spec) {
  if (Array.isArray(spec.items) && spec.items.length) return spec.items;
  if (Array.isArray(spec.rows) && spec.rows.length) return spec.rows.slice(1).map((r) => r.filter(Boolean).join('：'));
  return [];
}

function swotBuckets(spec) {
  const out = { S: [], W: [], O: [], T: [] };
  const rows = Array.isArray(spec.rows) && spec.rows.length ? spec.rows.slice(1) : [];
  if (rows.length) {
    for (const row of rows) {
      const key = String(row[0] || '').toUpperCase()[0];
      if (out[key]) out[key].push(...row.slice(1).filter(Boolean));
    }
  } else {
    (spec.items || []).forEach((item, i) => out[['S', 'W', 'O', 'T'][i % 4]].push(item));
  }
  return out;
}

function dashboardMetrics(spec) {
  if (Array.isArray(spec.rows) && spec.rows.length > 1) {
    return spec.rows.slice(1).map((r) => ({ label: String(r[0] || ''), value: String(r[1] || ''), note: String(r[2] || '') }));
  }
  return (spec.items || []).map((item) => {
    const parts = String(item).split(/[:：|]/).map((x) => x.trim()).filter(Boolean);
    return { label: parts[0] || item, value: parts[1] || '', note: parts[2] || '' };
  });
}

function addDeckLine(slide, x1, y1, x2, y2, line) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const shape = dx && dy && Math.sign(dx) !== Math.sign(dy) ? 'lineInv' : 'line';
  slide.addShape(shape, {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
    line,
  });
}

function addDeckConnector(slide, x1, y1, x2, y2, line) {
  const midY = y1 + (y2 - y1) / 2;
  addDeckLine(slide, x1, y1, x1, midY, line);
  addDeckLine(slide, x1, midY, x2, midY, line);
  addDeckLine(slide, x2, midY, x2, y2, line);
}

function renderOrgSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const items = diagramItems(spec).slice(0, 7).map((x) => shortenDeckText(x, 28));
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  const root = items[0] || 'Leadership';
  slide.addShape('rect', { x: 5.0, y: 1.95, w: 2.7, h: 0.68, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(root, { x: 5.2, y: 2.16, w: 2.3, h: 0.18, fontFace: 'Aptos', fontSize: 11.2, bold: true, color: 'FFFFFF', align: 'center', margin: 0, fit: 'shrink' });
  const children = items.slice(1, 4);
  const leaves = items.slice(4, 7);
  children.forEach((item, i) => {
    const x = 1.45 + i * 3.65;
    addDeckConnector(slide, 6.35, 2.63, x + 1.22, 3.45, { color: theme.line, pt: 1.2 });
    slide.addShape('rect', { x, y: 3.45, w: 2.45, h: 0.64, fill: { color: i % 2 ? theme.soft : 'FFFFFF' }, line: { color: theme.line, transparency: 18 } });
    slide.addShape('rect', { x, y: 3.45, w: 0.1, h: 0.64, fill: { color: i === 0 ? theme.accent3 : theme.accent2 }, line: { color: i === 0 ? theme.accent3 : theme.accent2 } });
    slide.addText(item, { x: x + 0.2, y: 3.64, w: 2.05, h: 0.18, fontFace: 'Aptos', fontSize: 10.6, bold: true, color: theme.ink, align: 'center', margin: 0, fit: 'shrink' });
  });
  leaves.forEach((item, i) => {
    const x = 1.65 + i * 3.65;
    slide.addShape('line', { x: x + 1.02, y: 4.09, w: 0, h: 0.5, line: { color: theme.line, pt: 1 } });
    slide.addShape('rect', { x, y: 4.58, w: 2.05, h: 0.52, fill: { color: theme.soft }, line: { color: theme.line, transparency: 25 } });
    slide.addText(item, { x: x + 0.14, y: 4.73, w: 1.76, h: 0.16, fontFace: 'Aptos', fontSize: 9.8, color: theme.ink, align: 'center', margin: 0, fit: 'shrink' });
  });
  slide.addText('Organization chart', { x: 0.98, y: 5.95, w: 2.6, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function renderGanttSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const tasks = ganttTasks(spec).slice(0, 6);
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  const x0 = 3.0, y0 = 2.05, w = 8.1;
  ['Q1', 'Q2', 'Q3', 'Q4'].forEach((q, i) => {
    slide.addText(q, { x: x0 + i * (w / 4), y: 1.82, w: w / 4, h: 0.18, fontFace: 'Aptos', fontSize: 9.8, bold: true, color: theme.muted, align: 'center', margin: 0 });
    slide.addShape('line', { x: x0 + i * (w / 4), y: 2.04, w: 0, h: 3.9, line: { color: theme.line, pt: 0.7, transparency: 30 } });
  });
  tasks.forEach((task, i) => {
    const y = y0 + i * 0.58;
    const start = Math.max(0, Math.min(3, task.start));
    const len = Math.max(1, Math.min(4 - start, task.len));
    slide.addText(shortenDeckText(task.label, 22), { x: 1.0, y: y + 0.08, w: 1.7, h: 0.18, fontFace: 'Aptos', fontSize: 9.8, color: theme.ink, margin: 0, fit: 'shrink' });
    slide.addShape('rect', { x: x0, y: y + 0.13, w, h: 0.18, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addShape('rect', { x: x0 + start * (w / 4), y: y + 0.08, w: len * (w / 4) - 0.08, h: 0.28, fill: { color: i === 0 ? theme.accent3 : theme.accent }, line: { color: i === 0 ? theme.accent3 : theme.accent } });
  });
  slide.addText('Gantt schedule', { x: 0.98, y: 5.95, w: 2.4, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function renderVennSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const items = diagramItems(spec).slice(0, 3).map((x) => shortenDeckText(x, 26));
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  slide.addShape('ellipse', { x: 2.3, y: 2.2, w: 3.1, h: 2.5, fill: { color: theme.accent, transparency: 45 }, line: { color: theme.accent, pt: 1.2 } });
  slide.addShape('ellipse', { x: 4.95, y: 2.2, w: 3.1, h: 2.5, fill: { color: theme.accent2, transparency: 45 }, line: { color: theme.accent2, pt: 1.2 } });
  slide.addShape('ellipse', { x: 3.65, y: 3.15, w: 3.1, h: 2.5, fill: { color: theme.accent3, transparency: 52 }, line: { color: theme.accent3, pt: 1.2 } });
  const labels = [items[0] || 'Set A', items[1] || 'Set B', items[2] || 'Intersection'];
  slide.addText(labels[0], { x: 2.65, y: 2.55, w: 1.7, h: 0.26, fontFace: 'Aptos', fontSize: 12, bold: true, color: 'FFFFFF', align: 'center', margin: 0, fit: 'shrink' });
  slide.addText(labels[1], { x: 5.65, y: 2.55, w: 1.7, h: 0.26, fontFace: 'Aptos', fontSize: 12, bold: true, color: 'FFFFFF', align: 'center', margin: 0, fit: 'shrink' });
  slide.addText(labels[2], { x: 4.25, y: 4.28, w: 1.9, h: 0.26, fontFace: 'Aptos', fontSize: 12, bold: true, color: theme.ink, align: 'center', margin: 0, fit: 'shrink' });
  slide.addText('Venn diagram', { x: 0.98, y: 5.95, w: 2.2, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function renderRadarSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const metrics = dashboardMetrics(spec).slice(0, 6);
  const safeMetrics = metrics.length ? metrics : [
    { label: 'Strategy', value: '82' },
    { label: 'Delivery', value: '76' },
    { label: 'Design', value: '88' },
    { label: 'Quality', value: '72' },
    { label: 'Growth', value: '80' },
  ];
  const cx = 4.6, cy = 3.95, radius = 1.55;
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  slide.addText('Radar profile', { x: 1.02, y: 1.9, w: 2.1, h: 0.24, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
  const pointsFor = (scale) => safeMetrics.map((_m, i) => {
    const a = (-90 + i * (360 / Math.max(3, safeMetrics.length))) * Math.PI / 180;
    return { x: cx + Math.cos(a) * radius * scale, y: cy + Math.sin(a) * radius * scale };
  });
  [1, 0.72, 0.44].forEach((scale) => {
    const pts = pointsFor(scale);
    pts.forEach((p, i) => {
      const n = pts[(i + 1) % pts.length];
      addDeckLine(slide, p.x, p.y, n.x, n.y, { color: theme.line, pt: 0.8, transparency: scale === 1 ? 8 : 28 });
    });
  });
  const scorePts = [];
  safeMetrics.forEach((m, i) => {
    const a = (-90 + i * (360 / Math.max(3, safeMetrics.length))) * Math.PI / 180;
    const val = Math.max(0.2, Math.min(1, Number(String(m.value).replace(/[^\d.]/g, '')) / 100 || (0.58 + i * 0.06)));
    const axis = { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius };
    const pt = { x: cx + Math.cos(a) * radius * val, y: cy + Math.sin(a) * radius * val };
    scorePts.push(pt);
    addDeckLine(slide, cx, cy, axis.x, axis.y, { color: theme.line, pt: 0.75, transparency: 35 });
    slide.addText(shortenDeckText(m.label, 12), { x: axis.x - 0.52, y: axis.y - 0.12, w: 1.04, h: 0.18, fontFace: 'Aptos', fontSize: 8.6, bold: true, color: theme.ink, align: 'center', margin: 0, fit: 'shrink' });
    slide.addShape('ellipse', { x: pt.x - 0.065, y: pt.y - 0.065, w: 0.13, h: 0.13, fill: { color: i === 0 ? theme.accent3 : theme.accent2 }, line: { color: 'FFFFFF', pt: 0.8 } });
  });
  scorePts.forEach((p, i) => {
    const n = scorePts[(i + 1) % scorePts.length];
    addDeckLine(slide, p.x, p.y, n.x, n.y, { color: theme.accent3, pt: 2.0, transparency: 0 });
  });
  slide.addShape('rect', { x: 7.05, y: 2.05, w: 4.1, h: 3.55, fill: { color: theme.soft }, line: { color: theme.line, transparency: 22 } });
  safeMetrics.slice(0, 6).forEach((m, i) => {
    const y = 2.34 + i * 0.49;
    const val = Math.max(0, Math.min(100, Number(String(m.value).replace(/[^\d.]/g, '')) || Math.round(58 + i * 6)));
    slide.addText(shortenDeckText(m.label, 14), { x: 7.3, y, w: 1.0, h: 0.18, fontFace: 'Aptos', fontSize: 9.2, bold: true, color: theme.ink, margin: 0, fit: 'shrink' });
    slide.addShape('rect', { x: 8.5, y: y + 0.04, w: 1.75, h: 0.11, fill: { color: 'DDE7F0' }, line: { color: 'DDE7F0' } });
    slide.addShape('rect', { x: 8.5, y: y + 0.04, w: 1.75 * (val / 100), h: 0.11, fill: { color: i === 0 ? theme.accent3 : theme.accent }, line: { color: i === 0 ? theme.accent3 : theme.accent } });
    slide.addText(String(val), { x: 10.38, y: y - 0.01, w: 0.42, h: 0.16, fontFace: 'Aptos', fontSize: 8.8, bold: true, color: theme.accent, align: 'right', margin: 0 });
  });
  slide.addText('Capability radar', { x: 0.98, y: 5.95, w: 2.6, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function renderArchitectureSlide(slide, spec, theme) {
  renderDeckTitle(slide, spec.title, theme);
  const modules = diagramItems(spec).slice(0, 7).map((x) => shortenDeckText(x, 24));
  slide.addShape('rect', { x: 0.72, y: 1.62, w: 11.25, h: 5.05, fill: { color: theme.panel }, line: { color: theme.line, transparency: 28 } });
  slide.addText('Layered system architecture', { x: 0.98, y: 1.9, w: 3.35, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.7 });
  const labels = [
    modules[0] || 'Client / Channel',
    modules[1] || 'API Gateway',
    modules[2] || 'Kernel Orchestrator',
    modules[3] || 'Layout Engine',
    modules[4] || 'Office Renderer',
    modules[5] || 'Quality Gate',
    modules[6] || 'Preview API',
  ];
  const layers = [
    { name: 'Experience', y: 2.22, color: theme.accent2, items: [labels[0], labels[1]] },
    { name: 'Core', y: 3.38, color: theme.accent, items: [labels[2], labels[3], labels[4]] },
    { name: 'Assurance', y: 4.72, color: theme.accent3, items: [labels[5], labels[6]] },
  ];
  layers.forEach((layer) => {
    slide.addShape('rect', { x: 1.0, y: layer.y - 0.18, w: 10.45, h: 0.92, fill: { color: layer.y === 3.38 ? 'F8FAFC' : theme.soft }, line: { color: theme.line, transparency: 26 } });
    slide.addShape('rect', { x: 1.0, y: layer.y - 0.18, w: 0.16, h: 0.92, fill: { color: layer.color }, line: { color: layer.color } });
    slide.addText(layer.name, { x: 1.28, y: layer.y + 0.1, w: 1.2, h: 0.18, fontFace: 'Aptos', fontSize: 9.2, bold: true, color: layer.color, margin: 0, fit: 'shrink' });
    const startX = layer.items.length === 3 ? 3.05 : 4.0;
    layer.items.forEach((m, i) => {
      const x = startX + i * 2.55;
      slide.addShape('rect', { x, y: layer.y, w: 2.05, h: 0.5, fill: { color: 'FFFFFF' }, line: { color: layer.color, pt: 1.0, transparency: 6 } });
      slide.addShape('rect', { x, y: layer.y, w: 0.08, h: 0.5, fill: { color: layer.color }, line: { color: layer.color } });
      slide.addText(m, { x: x + 0.16, y: layer.y + 0.15, w: 1.72, h: 0.15, fontFace: 'Aptos', fontSize: 9.3, bold: true, color: theme.ink, align: 'center', margin: 0, fit: 'shrink' });
    });
  });
  addDeckLine(slide, 6.15, 2.72, 6.15, 3.22, { color: theme.accent, pt: 1.25, endArrowType: 'triangle' });
  addDeckLine(slide, 6.15, 4.02, 6.15, 4.55, { color: theme.accent, pt: 1.25, endArrowType: 'triangle' });
  slide.addText('request', { x: 6.34, y: 2.88, w: 0.7, h: 0.14, fontFace: 'Aptos', fontSize: 7.8, color: theme.muted, margin: 0 });
  slide.addText('verify', { x: 6.34, y: 4.2, w: 0.7, h: 0.14, fontFace: 'Aptos', fontSize: 7.8, color: theme.muted, margin: 0 });
  slide.addText('System architecture', { x: 0.98, y: 5.95, w: 2.9, h: 0.22, fontFace: 'Aptos', fontSize: 10.5, bold: true, color: theme.accent2, margin: 0, charSpace: 0.8 });
}

function ganttTasks(spec) {
  if (Array.isArray(spec.rows) && spec.rows.length > 1) {
    return spec.rows.slice(1).map((r, i) => ({
      label: String(r[0] || `Task ${i + 1}`),
      start: Math.max(0, Math.min(3, Number(r[1]) - 1 || i % 4)),
      len: Math.max(1, Math.min(4, Number(r[2]) || 1)),
    }));
  }
  return (spec.items || []).map((x, i) => ({ label: String(x), start: i % 4, len: Math.min(2, 4 - (i % 4)) }));
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

// 依副檔名驗證產出文件是否有效（給 docgen 的 verify 徽章用）：
// pdf→%PDF、Office→ZIP(PK)+可回讀文字、html→含標籤、其餘(csv…)→非空。
export function isValidDoc(path) {
  try {
    if (!existsSync(path)) return false;
    const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    const buf = readFileSync(path);
    if (ext === 'pdf') return buf.subarray(0, 5).toString() === '%PDF-';
    if (ext === 'docx' || ext === 'pptx' || ext === 'xlsx') {
      if (buf.subarray(0, 2).toString() !== 'PK') return false;
      try { return extractDocText(path).trim().length > 0; } catch { return false; }
    }
    if (ext === 'html' || ext === 'htm') return /<html|<!doctype/i.test(buf.toString('utf8').slice(0, 300));
    return buf.length > 0;
  } catch { return false; }
}

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

// PPTX 轉檔器：soffice / libreoffice（Impress 由 HTML 匯入，標題自動分頁）。回 { kind, bin } 或 null。
function detectPptx() {
  for (const b of ['soffice', 'libreoffice']) { const p = has(b); if (p) return { kind: 'soffice', bin: p }; }
  return null;
}
function renderHtmlToPptx(htmlPath, outPath, r) {
  try {
    const od = dirname(outPath);
    spawnSync(r.bin, ['--headless', '--convert-to', 'pptx', '--outdir', od, htmlPath], { encoding: 'utf8', timeout: 60000 });
    const produced = join(od, basename(htmlPath).replace(/\.html?$/i, '') + '.pptx');
    if (produced !== outPath && isZip(produced)) { try { writeFileSync(outPath, readFileSync(produced)); rmSync(produced); } catch { /* 略 */ } }
    return isZip(outPath) ? { ok: true, tool: r.kind } : { ok: false, reason: `${r.kind} 未產生有效 pptx` };
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
  pptx: { detect: detectPptx, render: renderHtmlToPptx, tools: 'soffice / libreoffice' },
};

export function officeCapabilities() {
  const pdf = detectRenderer();
  const docx = detectDocx();
  const pptx = detectPptx();
  const pdftotext = has('pdftotext');
  const nativeDocx = hasPackage('docx');
  const nativePptx = hasPackage('pptxgenjs');
  return {
    read: {
      docx: 'built-in',
      xlsx: 'built-in',
      pptx: 'built-in',
      odf: 'built-in',
      rtf: 'built-in',
      pdf: pdftotext ? 'pdftotext' : false,
    },
    write: {
      html: 'built-in',
      csv: 'built-in',
      xlsx: 'built-in',
      pdf: pdf?.kind || false,
      docx: nativeDocx ? 'docx-native' : (docx?.kind || false),
      pptx: nativePptx ? 'pptx-native' : (pptx?.kind || false),
    },
    tools: {
      pdftotext: Boolean(pdftotext),
      pandoc: Boolean(has('pandoc')),
      soffice: Boolean(has('soffice') || has('libreoffice')),
      chrome: pdf?.kind === 'chrome',
      wkhtmltopdf: pdf?.kind === 'wkhtmltopdf',
    },
  };
}

/**
 * 產生文件成品。依 outPath 副檔名：.pdf / .docx / .pptx → 產檔或轉檔；其餘 → HTML。
 * @returns {Promise<{ ok:boolean, format:string, path:string, bytes:number, tool?:string, note?:string }>}
 */
export async function generateDoc(markdown, outPath, { title = '' } = {}) {
  const ext = (outPath.match(/\.([a-z0-9]+)$/i)?.[1] || 'html').toLowerCase();

  // XLSX（零相依）：每個 GFM 表格生成一張工作表；表格前最近的 markdown 標題作為 sheet 名稱。
  if (ext === 'xlsx') {
    const tables = mdTablesToRows(markdown);
    if (!tables.length) return { ok: false, format: 'xlsx', path: outPath, bytes: 0, note: '找不到可轉 XLSX 的表格——請提供一個或多個 GFM 表格。' };
    const r = writeXlsxFromTables(tables, outPath);
    return { ok: true, format: 'xlsx', path: outPath, bytes: r.bytes, sheets: r.sheets, rows: r.rows, tool: 'built-in' };
  }

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
  if (ext === 'docx') {
    try {
      const r = await renderMarkdownToDocx(markdown, outPath, { title });
      if (r.ok) return { ok: true, format: 'docx', path: outPath, bytes: readFileSync(outPath).length, tool: r.tool };
    } catch { /* fallback to converter below */ }
  }
  if (ext === 'pptx') {
    try {
      const r = await renderMarkdownToPptx(markdown, outPath, { title });
      if (r.ok) return { ok: true, format: 'pptx', path: outPath, bytes: readFileSync(outPath).length, tool: r.tool, slides: r.slides };
    } catch { /* fallback to converter below */ }
  }
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
