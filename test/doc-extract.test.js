// 文件文字萃取：用 Node 內建 zlib 現場合成最小 OOXML/ODF zip（含 stored 與 deflate 兩種壓縮），
// 驗證 ZIP 解析 + XML 剝離 + 實體解碼；RTF 直接寫檔測純 JS 去控制字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { isDocFile, extractDoc, extractDocText, DOC_EXTENSIONS } from '../src/packs/shared/doc-extract.js';

const dir = mkdtempSync(join(tmpdir(), 'docx-'));
const tmp = (name) => join(dir, name);

// 最小 ZIP 寫入器（CRC 填 0——萃取器不驗 CRC；故意混用 stored/deflate 覆蓋兩條解壓路徑）
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  files.forEach((f, i) => {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data, 'utf8');
    const stored = i % 2 === 0;                 // 交錯：偶數 stored、奇數 deflate
    const comp = stored ? raw : deflateRawSync(raw);
    const method = stored ? 0 : 8;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(local, 30);
    const localFull = Buffer.concat([local, comp]);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42); nameBuf.copy(central, 46);
    locals.push(localFull); centrals.push(central); offset += localFull.length;
  });
  const localAll = Buffer.concat(locals), cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(localAll.length, 16);
  return Buffer.concat([localAll, cd, eocd]);
}
const writeZip = (name, files) => { const p = tmp(name); writeFileSync(p, makeZip(files)); return p; };

test('isDocFile：依副檔名判斷（大小寫不敏感），純文字不算', () => {
  assert.ok(isDocFile('a.docx') && isDocFile('A.PDF') && isDocFile('x.xlsx'));
  assert.ok(!isDocFile('a.txt') && !isDocFile('a.md') && !isDocFile('a'));
  assert.deepEqual(new Set(DOC_EXTENSIONS), new Set(['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods', '.rtf', '.pdf']));
});

test('docx：段落換行 + 實體解碼 + tab/br', () => {
  const xml = '<w:document><w:body>' +
    '<w:p><w:r><w:t>第一段 A &amp; B</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>左</w:t><w:tab/><w:t>右</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>換</w:t><w:br/><w:t>行</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const p = writeZip('a.docx', [{ name: 'word/document.xml', data: xml }]);
  assert.equal(extractDocText(p), '第一段 A & B\n左\t右\n換\n行');
});

test('docx：結構化萃取保留段落與表格', () => {
  const xml = '<w:document><w:body>' +
    '<w:p><w:r><w:t>摘要</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>名稱</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>數量</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '</w:body></w:document>';
  const p = writeZip('table.docx', [{ name: 'word/document.xml', data: xml }]);
  const doc = extractDoc(p);
  assert.equal(doc.kind, 'docx');
  assert.deepEqual(doc.blocks[0], { type: 'paragraph', text: '摘要' });
  assert.deepEqual(doc.blocks[1], { type: 'table', rows: [['名稱', '數量'], ['甲', '1']] });
  assert.match(doc.text, /摘要\n名稱\t數量\n甲\t1/);
});

test('pptx：多張投影片各自標頭 + 文字', () => {
  const slide = (t) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  // 故意亂序提供，驗證會依 slideN 數字排序
  const p = writeZip('deck.pptx', [
    { name: 'ppt/slides/slide2.xml', data: slide('第二頁') },
    { name: 'ppt/slides/slide1.xml', data: slide('第一頁') },
  ]);
  const out = extractDocText(p);
  assert.match(out, /--- 投影片 1 ---\n第一頁/);
  assert.match(out, /--- 投影片 2 ---\n第二頁/);
  assert.ok(out.indexOf('第一頁') < out.indexOf('第二頁'));
  const doc = extractDoc(p);
  assert.equal(doc.slides.length, 2);
  assert.equal(doc.slides[0].text, '第一頁');
});

test('pptx：結構化萃取保留 title/body placeholder', () => {
  const shape = (role, paragraphs) => `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${role}"/></p:nvPr></p:nvSpPr><p:txBody>${paragraphs.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const slide = '<p:sld><p:cSld><p:spTree>' +
    shape('title', ['季度摘要']) +
    shape('body', ['營收成長', '成本下降']) +
    '</p:spTree></p:cSld></p:sld>';
  const p = writeZip('structured.pptx', [{ name: 'ppt/slides/slide1.xml', data: slide }]);
  const doc = extractDoc(p);
  assert.equal(doc.kind, 'pptx');
  assert.equal(doc.slides[0].title, '季度摘要');
  assert.deepEqual(doc.slides[0].body, ['營收成長', '成本下降']);
  assert.deepEqual(doc.slides[0].blocks, [
    { role: 'title', paragraphs: ['季度摘要'] },
    { role: 'body', paragraphs: ['營收成長', '成本下降'] },
  ]);
  assert.equal(doc.slides[0].text, '季度摘要\n營收成長\n成本下降');
});

test('pptx：結構化萃取保留投影片圖片 data URI', () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ]);
  const slide = '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>含圖頁</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  const rels = '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>';
  const p = writeZip('image.pptx', [
    { name: 'ppt/slides/slide1.xml', data: slide },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels },
    { name: 'ppt/media/image1.png', data: png },
  ]);
  const doc = extractDoc(p);
  assert.equal(doc.slides[0].images.length, 1);
  assert.equal(doc.slides[0].images[0].name, 'image1.png');
  assert.equal(doc.slides[0].images[0].mime, 'image/png');
  assert.match(doc.slides[0].images[0].dataUrl, /^data:image\/png;base64,/);
});

test('pptx：結構化萃取保留投影片表格與圖表摘要', () => {
  const table = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl>' +
    '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>季度</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>金額</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
    '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>100</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const slide = '<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>營收</a:t></a:r></a:p></p:txBody></p:sp>' + table + '</p:spTree></p:cSld></p:sld>';
  const rels = '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>';
  const chart = '<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:v>North</c:v></c:tx><c:cat><c:strLit><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:pt idx="0"><c:v>100</c:v></c:pt><c:pt idx="1"><c:v>120</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>';
  const p = writeZip('table-chart.pptx', [
    { name: 'ppt/slides/slide1.xml', data: slide },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels },
    { name: 'ppt/charts/chart1.xml', data: chart },
  ]);
  const doc = extractDoc(p);
  assert.deepEqual(doc.slides[0].tables[0].rows, [['季度', '金額'], ['Q1', '100']]);
  assert.equal(doc.slides[0].charts[0].type, 'bar');
  assert.equal(doc.slides[0].charts[0].title, 'Revenue');
  assert.deepEqual(doc.slides[0].charts[0].series[0], { name: 'North', categories: ['Q1', 'Q2'], values: [100, 120] });
  assert.match(doc.slides[0].text, /季度\t金額\nQ1\t100/);
  assert.match(doc.slides[0].text, /圖表：Revenue \(bar\)/);
});

test('xlsx：共用字串表解析 + sheet 名稱 + cell address 對齊', () => {
  const ss = '<sst><si><t>名稱</t></si><si><t>價格</t></si><si><t>蘋果</t></si></sst>';
  const workbook = '<workbook><sheets><sheet name="銷售" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const sheet = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>35</v></c></row>' +
    '</sheetData></worksheet>';
  const p = writeZip('sheet.xlsx', [
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: ss },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
  const doc = extractDoc(p);
  assert.equal(doc.kind, 'xlsx');
  assert.equal(doc.sheets[0].name, '銷售');
  assert.deepEqual(doc.sheets[0].rows[1].cells, ['蘋果', '', '35']);
  assert.match(extractDocText(p), /--- 銷售 ---\n名稱\t價格\n蘋果\t\t35/);
});

test('xlsx：結構化預覽保留公式與合併範圍', () => {
  const workbook = '<workbook><sheets><sheet name="分析" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const sheet = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>項目</t></is></c><c r="B1" t="inlineStr"><is><t>總計</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>收入</t></is></c><c r="B2"><f>SUM(C2:D2)</f></c><c r="C2"><v>10</v></c><c r="D2"><v>15</v></c></row>' +
    '</sheetData><mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells></worksheet>';
  const p = writeZip('formula.xlsx', [
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
  const doc = extractDoc(p);
  assert.deepEqual(doc.sheets[0].merges, ['A3:B3']);
  assert.deepEqual(doc.sheets[0].formulas, [{ ref: 'B2', formula: 'SUM(C2:D2)', value: '' }]);
  assert.deepEqual(doc.sheets[0].rows[1].cells, ['收入', '=SUM(C2:D2)', '10', '15']);
});

test('odt：text:p 換行 + tab', () => {
  const content = '<office:document-content><office:body><office:text>' +
    '<text:p>標題段</text:p><text:p>左<text:tab/>右</text:p>' +
    '</office:text></office:body></office:document-content>';
  const p = writeZip('doc.odt', [{ name: 'content.xml', data: content }]);
  assert.equal(extractDocText(p), '標題段\n左\t右');
});

test('rtf：去控制字、\\par 換行、unicode 跳脫', () => {
  const p = tmp('note.rtf');
  writeFileSync(p, '{\\rtf1\\ansi Hello\\par World\\par \\u20013?\\u22269?}');
  const out = extractDocText(p);
  assert.match(out, /Hello\nWorld/);
  assert.match(out, /中国/); // u20013=zhong u22269=guo
});

test('壞檔：非 ZIP 的 .docx 丟出可讀錯誤', () => {
  const p = tmp('broken.docx');
  writeFileSync(p, 'not a zip at all');
  assert.throws(() => extractDocText(p), /ZIP|Office|中央目錄/);
});
