// 文件文字萃取：用 Node 內建 zlib 現場合成最小 OOXML/ODF zip（含 stored 與 deflate 兩種壓縮），
// 驗證 ZIP 解析 + XML 剝離 + 實體解碼；RTF 直接寫檔測純 JS 去控制字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { isDocFile, extractDocText, DOC_EXTENSIONS } from '../src/packs/shared/doc-extract.js';

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

test('pptx：多張投影片各自標頭 + 文字', () => {
  const slide = (t) => `<p:sld><p:cSld><p:spTree><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`;
  // 故意亂序提供，驗證會依 slideN 數字排序
  const p = writeZip('deck.pptx', [
    { name: 'ppt/slides/slide2.xml', data: slide('第二頁') },
    { name: 'ppt/slides/slide1.xml', data: slide('第一頁') },
  ]);
  const out = extractDocText(p);
  assert.match(out, /--- 投影片 1 ---\n第一頁/);
  assert.match(out, /--- 投影片 2 ---\n第二頁/);
  assert.ok(out.indexOf('第一頁') < out.indexOf('第二頁'));
});

test('xlsx：共用字串表解析 + 行列 TSV', () => {
  const ss = '<sst><si><t>名稱</t></si><si><t>價格</t></si><si><t>蘋果</t></si></sst>';
  const sheet = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>35</v></c></row>' +
    '</sheetData></worksheet>';
  const p = writeZip('sheet.xlsx', [
    { name: 'xl/sharedStrings.xml', data: ss },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
  const out = extractDocText(p);
  assert.match(out, /名稱\t價格/);
  assert.match(out, /蘋果\t35/);
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
