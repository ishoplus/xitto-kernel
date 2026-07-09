// docgen：md → 可列印 HTML（零相依、中文 OK）；generateDoc 寫檔；.pdf 走渲染器或 fallback HTML；
// gen_doc 工具經 kernel 產出成品。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { mdToHtml, mdToBody, generateDoc, mdTableToRows, mdTablesToRows, toCsv, isValidDoc, officeCapabilities } from '../src/packs/shared/doc-gen.js';
import { extractDoc } from '../src/packs/shared/doc-extract.js';
import { analyzePptxTemplate, generatePptxFromTemplate, validatePptxTemplateOutput } from '../src/packs/shared/pptx-template.js';
import { createKernel } from '../src/kernel/index.js';
import { createDocgenPack } from '../src/packs/docgen/index.js';
import { readArtifactMetadata } from '../src/packs/shared/artifact-metadata.js';

const FAKE_MODEL = { id: 'fake', provider: 'fake', api: 'openai-completions', baseUrl: '', input: ['text'], output: ['text'], contextWindow: 32000, maxTokens: 4096, cost: {} };
const textMsg = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }], stopReason: 'stop', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const toolMsg = (name, args) => ({ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name, arguments: args }], stopReason: 'toolUse', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const streamOf = (m) => { const s = new AssistantMessageEventStream(); s.push({ type: 'start', partial: m }); s.push({ type: 'done', reason: m.stopReason, message: m }); return s; };
const fakeProvider = (turns) => { let i = 0; return () => streamOf(turns[Math.min(i++, turns.length - 1)]); };

const MD = `# 季度報告\n\n這是**重點**與 \`code\`。\n\n- 項目一\n- 項目二\n\n| 名稱 | 數量 |\n| --- | --- |\n| 甲 | 1 |\n\n> 引言一句。`;

function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const localFull = Buffer.concat([local, data]);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(localFull); centrals.push(central); offset += localFull.length;
  }
  const localAll = Buffer.concat(locals), cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(localAll.length, 16);
  return Buffer.concat([localAll, cd, eocd]);
}

function readZipEntries(path) {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    assert.equal(method, 0);
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localNameLen + localExtraLen;
    files.push({ name, data: buf.subarray(start, start + size) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function slideBoxes(path, slideName = 'ppt/slides/slide1.xml') {
  const xml = readZipEntries(path).find((e) => e.name === slideName)?.data.toString('utf8') || '';
  return [...xml.matchAll(/<p:(?:sp|pic|graphicFrame)\b[\s\S]*?<\/p:(?:sp|pic|graphicFrame)>/g)].map(([shape]) => {
    const name = (shape.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/) || [])[1] || '';
    const xfrm = (shape.match(/<(?:a|p):xfrm\b[\s\S]*?<\/(?:a|p):xfrm>/) || [])[0] || '';
    const off = (xfrm.match(/<a:off\b([^>]*)\/?>/) || [])[1] || '';
    const ext = (xfrm.match(/<a:ext\b([^>]*)\/?>/) || [])[1] || '';
    const num = (attrs, key) => Number((attrs.match(new RegExp(`\\b${key}="([^"]*)"`)) || [])[1]);
    return { name, x: num(off, 'x'), y: num(off, 'y'), cx: num(ext, 'cx'), cy: num(ext, 'cy') };
  });
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.cx && a.x + a.cx > b.x && a.y < b.y + b.cy && a.y + a.cy > b.y;
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
const PNG_WIDE = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(400, 16);
  b.writeUInt32BE(100, 20);
  return b;
})();

function makePptxTemplate({ picture = false } = {}) {
  const presentation = '<p:presentation><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/></p:presentation>';
  const presRels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>';
  const master = '<p:sldMaster/>';
  const masterRels = '<Relationships>' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>';
  const picturePh = picture
    ? '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture Placeholder"/><p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="3"/></p:nvPr></p:nvPicPr><p:spPr><a:xfrm><a:off x="5486400" y="1600200"/><a:ext cx="3200400" cy="1800000"/></a:xfrm></p:spPr></p:pic>'
    : '';
  const layout = '<p:sldLayout name="Title and Content"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr></p:sp>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm></p:spPr></p:sp>' +
    picturePh +
    '</p:spTree></p:cSld></p:sldLayout>';
  const theme = '<a:theme name="Corp"><a:themeElements><a:clrScheme><a:srgbClr val="1F4E79"/><a:srgbClr val="F2F2F2"/></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Microsoft JhengHei"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>';
  return makeZip([
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: masterRels },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/theme/theme1.xml', data: theme },
  ]);
}

function makeNoPlaceholderPptxTemplate() {
  const presentation = '<p:presentation><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/></p:presentation>';
  const presRels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>';
  const master = '<p:sldMaster/>';
  const masterRels = '<Relationships>' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>';
  const layout = '<p:sldLayout name="Blank Corporate"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Decorative Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>';
  const theme = '<a:theme name="Corp"><a:themeElements><a:clrScheme><a:srgbClr val="1F4E79"/><a:srgbClr val="F2F2F2"/></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Microsoft JhengHei"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>';
  return makeZip([
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: masterRels },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/theme/theme1.xml', data: theme },
  ]);
}

function makeTablePptxTemplate() {
  const presentation = '<p:presentation><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/></p:presentation>';
  const presRels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>';
  const master = '<p:sldMaster/>';
  const masterRels = '<Relationships>' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>';
  const layout = '<p:sldLayout name="Table Layout"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="914400"/></a:xfrm></p:spPr></p:sp>' +
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table Placeholder"/><p:cNvGraphicFramePr/><p:nvPr><p:ph type="tbl" idx="2"/></p:nvPr></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="2743200"/></p:xfrm></p:graphicFrame>' +
    '</p:spTree></p:cSld></p:sldLayout>';
  const theme = '<a:theme name="Corp"><a:themeElements><a:clrScheme><a:srgbClr val="1F4E79"/></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>';
  return makeZip([
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: masterRels },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/theme/theme1.xml', data: theme },
  ]);
}

function makeChartPptxTemplate() {
  const presentation = '<p:presentation><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/></p:presentation>';
  const presRels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>';
  const master = '<p:sldMaster/>';
  const masterRels = '<Relationships>' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>';
  const layout = '<p:sldLayout name="Chart Layout"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="914400"/></a:xfrm></p:spPr></p:sp>' +
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart Placeholder"/><p:cNvGraphicFramePr/><p:nvPr><p:ph type="chart" idx="2"/></p:nvPr></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1371600"/><a:ext cx="8229600" cy="3200400"/></p:xfrm></p:graphicFrame>' +
    '</p:spTree></p:cSld></p:sldLayout>';
  const theme = '<a:theme name="Corp"><a:themeElements><a:clrScheme><a:srgbClr val="1F4E79"/></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>';
  return makeZip([
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: masterRels },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/theme/theme1.xml', data: theme },
  ]);
}

function makeMultiLayoutPptxTemplate() {
  const presentation = '<p:presentation><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/></p:presentation>';
  const presRels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>';
  const master = '<p:sldMaster/>';
  const masterRels = '<Relationships>' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout2.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout3.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>';
  const titleOnly = '<p:sldLayout name="Title Only"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr></p:sp>' +
    '</p:spTree></p:cSld></p:sldLayout>';
  const titleContent = '<p:sldLayout name="Title and Content"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="914400"/></a:xfrm></p:spPr></p:sp>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="3600000"/></a:xfrm></p:spPr></p:sp>' +
    '</p:spTree></p:cSld></p:sldLayout>';
  const picture = '<p:sldLayout name="Picture with Caption"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="914400"/></a:xfrm></p:spPr></p:sp>' +
    '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture Placeholder"/><p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="3"/></p:nvPr></p:nvPicPr><p:spPr><a:xfrm><a:off x="457200" y="1371600"/><a:ext cx="4114800" cy="2743200"/></a:xfrm></p:spPr></p:pic>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="5029200" y="1600200"/><a:ext cx="3657600" cy="2286000"/></a:xfrm></p:spPr></p:sp>' +
    '</p:spTree></p:cSld></p:sldLayout>';
  const theme = '<a:theme name="Corp"><a:themeElements><a:clrScheme><a:srgbClr val="1F4E79"/></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>';
  return makeZip([
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: masterRels },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: titleOnly },
    { name: 'ppt/slideLayouts/slideLayout2.xml', data: titleContent },
    { name: 'ppt/slideLayouts/slideLayout3.xml', data: picture },
    { name: 'ppt/theme/theme1.xml', data: theme },
  ]);
}

test('mdToBody：標題/清單/表格/粗體/code/引言 + 中文', () => {
  const h = mdToBody(MD);
  assert.match(h, /<h1>季度報告<\/h1>/);
  assert.match(h, /<ul>\s*<li>項目一<\/li>/);
  assert.match(h, /<table>.*<th>名稱<\/th>/s);
  assert.match(h, /<strong>重點<\/strong>/);
  assert.match(h, /<code>code<\/code>/);
  assert.match(h, /<blockquote>引言一句。<\/blockquote>/);
});

test('mdToHtml：完整文件 + 中文友善字體 + 列印樣式', () => {
  const html = mdToHtml(MD, { title: '報告' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /PingFang TC|Noto Sans CJK|Microsoft JhengHei/); // CJK 字體
  assert.match(html, /@page/);
  assert.match(html, /季度報告/);
});

test('generateDoc：.html → 寫出有效 HTML 檔', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-'));
  try {
    const out = join(cwd, 'r.html');
    const r = await generateDoc(MD, out, { title: '報告' });
    assert.equal(r.ok, true);
    assert.equal(r.format, 'html');
    assert.ok(existsSync(out));
    assert.match(readFileSync(out, 'utf8'), /<!doctype html>[\s\S]*季度報告/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.pdf → PDF（有渲染器）或 fallback HTML（無）；兩者皆 ok', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn2-'));
  try {
    const out = join(cwd, 'r.pdf');
    const r = await generateDoc(MD, out, { title: '報告' });
    assert.equal(r.ok, true);
    if (r.format === 'pdf') {
      assert.ok(existsSync(out));
      assert.equal(readFileSync(out).subarray(0, 5).toString(), '%PDF-', '應為有效 PDF');
      assert.ok(r.tool);
    } else {
      assert.equal(r.format, 'html');           // 無渲染器 → 退回 HTML
      assert.ok(existsSync(join(cwd, 'r.html')));
      assert.match(r.note, /渲染器|HTML/);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.docx → Word（有 pandoc/soffice）或 fallback HTML（無）；兩者皆 ok', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-docx-'));
  try {
    const out = join(cwd, 'r.docx');
    const r = await generateDoc(MD, out, { title: '報告' });
    assert.equal(r.ok, true);
    if (r.format === 'docx') {
      assert.ok(existsSync(out));
      assert.equal(readFileSync(out).subarray(0, 2).toString(), 'PK', 'docx 應為 ZIP(PK) 容器');
      if (officeCapabilities().write.docx === 'docx-native') assert.equal(r.tool, 'docx-native');
      else assert.ok(r.tool);
    } else {
      assert.equal(r.format, 'html');
      assert.ok(existsSync(join(cwd, 'r.html')));
      assert.match(r.note, /docx|DOCX|HTML/i);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.pptx → 簡報（有 soffice）或 fallback HTML（無）；兩者皆 ok', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-pptx-'));
  try {
    const out = join(cwd, 'slides.pptx');
    const r = await generateDoc('# 第一頁\n重點一\n\n# 第二頁\n重點二', out, { title: '簡報' });
    assert.equal(r.ok, true);
    if (r.format === 'pptx') {
      assert.ok(existsSync(out));
      assert.equal(readFileSync(out).subarray(0, 2).toString(), 'PK', 'pptx 應為 ZIP(PK) 容器');
      assert.ok(isValidDoc(out), 'isValidDoc 認得 pptx');
      if (officeCapabilities().write.pptx === 'pptx-native') assert.equal(r.tool, 'pptx-native');
      else assert.ok(r.tool);
    } else {
      assert.equal(r.format, 'html');           // 無 soffice → 退回 HTML
      assert.ok(existsSync(join(cwd, 'slides.html')));
      assert.match(r.note, /pptx|PPTX|HTML/i);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.pptx 無模板會用受控版型拆分長內容與表格', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-pptx-layout-'));
  try {
    const out = join(cwd, 'deck.pptx');
    const bullets = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 項：這是一段需要被控制長度與分頁的商務重點，避免自由生成時硬塞在同一頁`);
    const rows = ['| 指標 | 數值 |', '| --- | --- |', ...Array.from({ length: 9 }, (_, i) => `| KPI ${i + 1} | ${100 + i} |`)].join('\n');
    const r = await generateDoc(`# 季度營運回顧\n這份簡報需要有清楚故事線、穩定留白與可交付的商務版面。\n\n${bullets.map((b) => `- ${b}`).join('\n')}\n\n${rows}`, out, { title: '季度營運回顧' });
    assert.equal(r.ok, true);
    assert.equal(r.format, 'pptx');
    assert.equal(r.tool, 'pptx-native');
    assert.equal(r.slides, 5);
    const doc = extractDoc(out);
    assert.equal(doc.slides.length, 5);
    assert.ok(doc.slides.some((s) => s.tables.length === 1));
    assert.ok(doc.slides.filter((s) => s.body.length > 0).every((s) => s.body.length <= 7));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('mdTableToRows / toCsv：表格抽取 + CSV 轉義', () => {
  const rows = mdTableToRows('前言\n\n| 名稱 | 備註 |\n| --- | --- |\n| 甲, 乙 | 含"引號" |\n| 丙 | 正常 |\n\n後記');
  assert.deepEqual(rows[0], ['名稱', '備註']);
  assert.equal(rows.length, 3);
  const csv = toCsv(rows);
  assert.match(csv, /"甲, 乙"/);          // 含逗號 → 加引號
  assert.match(csv, /"含""引號"""/);       // 內部引號 → 雙寫
  assert.equal(mdTableToRows('沒有表格的純文字'), null);
});

test('mdTablesToRows：多表格 + 前置標題作為 sheet 名稱', () => {
  const tables = mdTablesToRows('# 銷售\n\n| 月 | 金額 |\n| --- | --- |\n| 一月 | 10 |\n\n# 庫存\n\n| 品項 | 數量 |\n| --- | --- |\n| A | 3 |');
  assert.equal(tables.length, 2);
  assert.equal(tables[0].name, '銷售');
  assert.equal(tables[1].name, '庫存');
});

test('generateDoc：.xlsx → 零相依寫出真正 workbook（多 sheet，可回讀）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-xlsx-'));
  try {
    const out = join(cwd, 'book.xlsx');
    const r = await generateDoc('# 銷售\n\n| 月 | 金額 |\n| --- | --- |\n| 一月 | 10 |\n\n# 庫存\n\n| 品項 | 數量 |\n| --- | --- |\n| A | 3 |', out);
    assert.equal(r.ok, true);
    assert.equal(r.format, 'xlsx');
    assert.equal(r.sheets, 2);
    assert.equal(readFileSync(out).subarray(0, 2).toString(), 'PK');
    assert.ok(isValidDoc(out));
    const doc = extractDoc(out);
    assert.equal(doc.sheets.length, 2);
    assert.equal(doc.sheets[0].name, '銷售');
    assert.equal(doc.sheets[1].name, '庫存');
    assert.deepEqual(doc.sheets[0].rows[1].cells, ['一月', '10']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.xlsx 支援公式、向上合併與表頭樣式', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-xlsx-style-'));
  try {
    const out = join(cwd, 'styled.xlsx');
    const r = await generateDoc('# 統計\n\n| 名稱 | 值 | 備註 |\n| --- | --- | --- |\n| 合計 | =SUM(B3:B4) | 標題 |\n| A | 1 |  |\n| ^ | 2 |  |\n', out);
    assert.equal(r.ok, true);
    const raw = readFileSync(out, 'latin1');
    assert.match(raw, /<f>SUM\(B3:B4\)<\/f>/);
    assert.match(raw, /<mergeCell ref="A3:A4"\/>/);
    assert.match(raw, /s="1"/, 'header cells should carry a style');
    assert.ok(isValidDoc(out));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.xlsx 會自動為單表數值資料加上柱狀圖', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-xlsx-chart-'));
  try {
    const out = join(cwd, 'chart.xlsx');
    const r = await generateDoc('# 月報\n\n| 月份 | 數值 |\n| --- | --- |\n| 一月 | 10 |\n| 二月 | 20 |\n', out);
    assert.equal(r.ok, true);
    const raw = readFileSync(out, 'latin1');
    assert.match(raw, /xl\/charts\/chart1\.xml/);
    assert.match(raw, /xl\/drawings\/drawing1\.xml/);
    assert.match(raw, /<c:barChart>/);
    assert.ok(isValidDoc(out));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.xlsx 無表格 → ok:false + 提示', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-xlsx2-'));
  try {
    const r = await generateDoc('沒有表格。', join(cwd, 'book.xlsx'));
    assert.equal(r.ok, false);
    assert.match(r.note, /XLSX|表格/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.csv → 零相依寫出（UTF-8 BOM + 中文）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-csv-'));
  try {
    const out = join(cwd, 'data.csv');
    const r = await generateDoc('| 名稱 | 數量 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |', out);
    assert.equal(r.ok, true);
    assert.equal(r.format, 'csv');
    assert.equal(r.rows, 3);
    const buf = readFileSync(out);
    assert.equal(buf.subarray(0, 3).toString('hex'), 'efbbbf', '應有 UTF-8 BOM（Excel 中文）');
    assert.match(buf.toString('utf8'), /名稱,數量[\s\S]*甲,1/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.csv 無表格 → ok:false + 提示', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-csv2-'));
  try {
    const r = await generateDoc('這只是一段文字，沒有表格。', join(cwd, 'x.csv'));
    assert.equal(r.ok, false);
    assert.match(r.note, /表格|GFM/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('analyzePptxTemplate：解析 slide size、layout placeholder 與 theme', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-'));
  try {
    const p = join(cwd, 'template.pptx');
    writeFileSync(p, makePptxTemplate());
    const manifest = analyzePptxTemplate(p);
    assert.equal(manifest.kind, 'pptx-template');
    assert.deepEqual(manifest.slideSize, { cx: 9144000, cy: 5143500, type: 'screen16x9' });
    assert.equal(manifest.masters, 1);
    assert.equal(manifest.layouts.length, 1);
    assert.equal(manifest.layouts[0].name, 'Title and Content');
    assert.deepEqual(manifest.layouts[0].placeholders[0], { type: 'title', idx: '1', orient: '', sz: '', x: 457200, y: 274638, cx: 8229600, cy: 1143000 });
    assert.deepEqual(manifest.layouts[0].placeholders[1], { type: 'body', idx: '2', orient: '', sz: '', x: 457200, y: 1600200, cx: 8229600, cy: 4525963 });
    assert.deepEqual(manifest.theme.fonts, ['Aptos Display', 'Microsoft JhengHei']);
    assert.deepEqual(manifest.theme.colors, ['#1F4E79', '#F2F2F2']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：沿用模板 layout 填入 title/body 並輸出 PPTX', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-gen-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makePptxTemplate());
    const r = generatePptxFromTemplate(tpl, out, [
      { title: '封面', body: ['第一點', '第二點'] },
      { title: '結論', body: ['完成'] },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.slides, 2);
    assert.equal(readFileSync(out).subarray(0, 2).toString(), 'PK');
    assert.ok(isValidDoc(out));
    const doc = extractDoc(out);
    assert.equal(doc.slides.length, 2);
    assert.equal(doc.slides[0].title, '封面');
    assert.deepEqual(doc.slides[0].body, ['第一點', '第二點']);
    assert.equal(analyzePptxTemplate(out).layouts[0].name, 'Title and Content');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：填入圖片 placeholder 並保留可預覽圖片', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-img-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const img = join(cwd, 'logo.png');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makePptxTemplate({ picture: true }));
    writeFileSync(img, PNG_1X1);
    const r = generatePptxFromTemplate(tpl, out, [
      { title: '產品圖', body: ['圖片應在模板圖位'], images: [img] },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.images, 1);
    assert.equal(r.verify.ok, true);
    assert.equal(r.verify.images, 1);
    const raw = readFileSync(out, 'latin1');
    assert.match(raw, /ppt\/media\/image1\.png/);
    assert.match(raw, /relationships\/image/);
    const doc = extractDoc(out);
    assert.equal(doc.slides[0].title, '產品圖');
    assert.equal(doc.slides[0].images.length, 1);
    assert.equal(doc.slides[0].images[0].mime, 'image/png');
    assert.match(doc.slides[0].images[0].dataUrl, /^data:image\/png;base64,/);
    assert.equal(analyzePptxTemplate(out).layouts[0].placeholders[2].type, 'pic');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：模板 placeholder 重疊時自動改用安全分區', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-overlap-fallback-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const img = join(cwd, 'logo.png');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makePptxTemplate({ picture: true }));
    writeFileSync(img, PNG_1X1);
    const r = generatePptxFromTemplate(tpl, out, [
      { title: '圖文安全分區', body: ['圖片模板的原始 body 區域會壓到圖片', '生成器應改用左右分區'], images: [img] },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.verify.design.ok, true);
    assert.doesNotMatch(r.verify.design.issues.map((i) => i.code).join('\n'), /shape-overlap/);
    const boxes = slideBoxes(out);
    const body = boxes.find((b) => b.name === 'Content 1');
    const image = boxes.find((b) => b.name === 'logo.png');
    assert.ok(body);
    assert.ok(image);
    assert.equal(boxesOverlap(body, image), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：圖片預設 contain 保持比例不拉伸', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-img-fit-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const img = join(cwd, 'wide.png');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makePptxTemplate({ picture: true }));
    writeFileSync(img, PNG_WIDE);
    const r = generatePptxFromTemplate(tpl, out, [
      { title: '寬圖', images: [img] },
    ]);
    assert.equal(r.ok, true);
    const raw = readFileSync(out, 'latin1');
    assert.match(raw, /<a:off x="5486400" y="2100150"\/><a:ext cx="3200400" cy="800100"\/>/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：正文過多會自動拆頁避免超版', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-split-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makePptxTemplate());
    const body = Array.from({ length: 15 }, (_, i) => `重點 ${i + 1}`);
    const r = generatePptxFromTemplate(tpl, out, [{ title: '長列表', body }]);
    assert.equal(r.ok, true);
    assert.equal(r.slides, 3);
    const doc = extractDoc(out);
    assert.equal(doc.slides.length, 3);
    assert.equal(doc.slides[0].body.length, 5);
    assert.equal(doc.slides[1].title, '長列表（續 2）');
    assert.deepEqual(doc.slides[2].body, ['重點 11', '重點 12', '重點 13', '重點 14', '重點 15']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：填入表格 placeholder 並通過驗證', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-table-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makeTablePptxTemplate());
    const manifest = analyzePptxTemplate(tpl);
    assert.equal(manifest.layouts[0].placeholders[1].type, 'tbl');
    const r = generatePptxFromTemplate(tpl, out, [
      { title: '營收表', tables: [{ name: 'Revenue', rows: [['季度', '金額'], ['Q1', '100'], ['Q2', '120']] }] },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.tables, 1);
    assert.equal(r.verify.ok, true);
    assert.equal(r.verify.tables, 1);
    const raw = readFileSync(out, 'utf8');
    assert.match(raw, /<a:tbl>/);
    assert.match(raw, /<a:t>季度<\/a:t>/);
    assert.match(raw, /<a:t>120<\/a:t>/);
    assert.deepEqual(validatePptxTemplateOutput(out).layouts, ['Table Layout']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：表格過長會拆頁並保留表頭', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-table-split-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makeTablePptxTemplate());
    const rows = [['季度', '金額'], ...Array.from({ length: 17 }, (_, i) => [`Q${i + 1}`, String((i + 1) * 10)])];
    const r = generatePptxFromTemplate(tpl, out, [
      { title: '長表格', tables: [{ name: 'Revenue', rows }] },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.slides, 3);
    assert.equal(r.tables, 3);
    assert.equal(r.verify.tables, 3);
    const doc = extractDoc(out);
    assert.equal(doc.slides.length, 3);
    assert.equal(doc.slides[1].title, '長表格（續 2）');
    assert.deepEqual(doc.slides[0].tables[0].rows[0], ['季度', '金額']);
    assert.deepEqual(doc.slides[1].tables[0].rows[0], ['季度', '金額']);
    assert.deepEqual(doc.slides[2].tables[0].rows[0], ['季度', '金額']);
    assert.equal(doc.slides[0].tables[0].rows.length, 8);
    assert.equal(doc.slides[2].tables[0].rows.at(-1)[0], 'Q17');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：填入 chart placeholder 並產生原生圖表', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-chart-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makeChartPptxTemplate());
    const manifest = analyzePptxTemplate(tpl);
    assert.equal(manifest.layouts[0].placeholders[1].type, 'chart');
    const r = generatePptxFromTemplate(tpl, out, [
      { title: '營收圖', charts: [{ name: 'Revenue', categories: ['Q1', 'Q2'], values: [100, 120] }] },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.charts, 1);
    assert.equal(r.verify.ok, true);
    assert.equal(r.verify.charts, 1);
    const raw = readFileSync(out, 'latin1');
    assert.match(raw, /ppt\/charts\/chart1\.xml/);
    assert.match(raw, /relationships\/chart/);
    assert.match(raw, /application\/vnd\.openxmlformats-officedocument\.drawingml\.chart\+xml/);
    assert.match(raw, /<c:barChart>/);
    assert.match(raw, /<c:v>Q1<\/c:v>/);
    assert.match(raw, /<c:v>120<\/c:v>/);
    assert.deepEqual(validatePptxTemplateOutput(out).layouts, ['Chart Layout']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：無 placeholder 模板會自動分區避免正文表格圖表重疊', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-auto-layout-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makeNoPlaceholderPptxTemplate());
    const manifest = analyzePptxTemplate(tpl);
    assert.equal(manifest.layouts[0].placeholders.length, 0);
    const r = generatePptxFromTemplate(tpl, out, [{
      title: '自動分區',
      body: ['重點一', '重點二', '重點三'],
      tables: [{ name: 'KPI', rows: [['指標', '數值'], ['收入', '100'], ['成本', '40']] }],
      charts: [{ name: 'Trend', type: 'bar', categories: ['Q1', 'Q2', 'Q3'], values: [10, 20, 30] }],
    }]);
    assert.equal(r.ok, true);
    assert.equal(r.verify.ok, true);
    const boxes = slideBoxes(out);
    const body = boxes.find((b) => b.name === 'Content 1');
    const table = boxes.find((b) => b.name === 'KPI');
    const chart = boxes.find((b) => b.name === 'Trend');
    assert.ok(body);
    assert.ok(table);
    assert.ok(chart);
    assert.equal(boxesOverlap(body, table), false);
    assert.equal(boxesOverlap(body, chart), false);
    assert.equal(boxesOverlap(table, chart), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：支援 line/pie chart 與多系列', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-chart-types-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makeChartPptxTemplate());
    const r = generatePptxFromTemplate(tpl, out, [
      {
        title: '趨勢圖',
        charts: [{
          name: 'Revenue Trend',
          type: 'line',
          categories: ['Q1', 'Q2'],
          series: [
            { name: 'North', values: [100, 120] },
            { name: 'South', values: [80, 90] },
          ],
        }],
      },
      {
        title: '占比圖',
        charts: [{ name: 'Share', type: 'pie', categories: ['A', 'B'], values: [60, 40] }],
      },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.charts, 2);
    assert.equal(r.verify.ok, true);
    assert.equal(r.verify.charts, 2);
    const raw = readFileSync(out, 'latin1');
    assert.match(raw, /<c:lineChart>/);
    assert.match(raw, /<c:pieChart>/);
    assert.match(raw, /<c:v>North<\/c:v>/);
    assert.match(raw, /<c:v>South<\/c:v>/);
    assert.match(raw, /<c:v>40<\/c:v>/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：圖表分類過多會拆頁並保留系列', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-chart-split-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makeChartPptxTemplate());
    const categories = Array.from({ length: 17 }, (_, i) => `M${i + 1}`);
    const r = generatePptxFromTemplate(tpl, out, [
      {
        title: '月度趨勢',
        charts: [{
          name: 'Monthly Trend',
          type: 'line',
          categories,
          series: [
            { name: 'North', values: categories.map((_, i) => i + 1) },
            { name: 'South', values: categories.map((_, i) => (i + 1) * 2) },
          ],
        }],
      },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.slides, 3);
    assert.equal(r.charts, 3);
    assert.equal(r.verify.ok, true);
    assert.equal(r.verify.charts, 3);
    const entries = readZipEntries(out);
    const slideXml = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).map((e) => e.data.toString('utf8')).join('\n');
    const raw = entries.map((e) => e.data.toString('utf8')).join('\n');
    assert.match(slideXml, /月度趨勢（續 2）/);
    assert.match(slideXml, /月度趨勢（續 3）/);
    assert.match(raw, /<c:v>M8<\/c:v>/);
    assert.match(raw, /<c:v>M9<\/c:v>/);
    assert.match(raw, /<c:v>M17<\/c:v>/);
    assert.match(raw, /<c:v>North<\/c:v>/);
    assert.match(raw, /<c:v>South<\/c:v>/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generatePptxFromTemplate：依每頁內容智能選擇不同 layout', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-smart-layout-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const img = join(cwd, 'logo.png');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makeMultiLayoutPptxTemplate());
    writeFileSync(img, PNG_1X1);
    const r = generatePptxFromTemplate(tpl, out, [
      { title: '封面' },
      { title: '議程', body: ['第一點', '第二點'] },
      { title: '產品圖', body: ['圖片說明'], images: [img] },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.layouts, ['Title Only', 'Title and Content', 'Picture with Caption']);
    const raw = readFileSync(out, 'latin1');
    assert.match(raw, /ppt\/slides\/_rels\/slide1\.xml\.rels[\s\S]*Target="\.\.\/slideLayouts\/slideLayout1\.xml"/);
    assert.match(raw, /ppt\/slides\/_rels\/slide2\.xml\.rels[\s\S]*Target="\.\.\/slideLayouts\/slideLayout2\.xml"/);
    assert.match(raw, /ppt\/slides\/_rels\/slide3\.xml\.rels[\s\S]*Target="\.\.\/slideLayouts\/slideLayout3\.xml"/);
    const doc = extractDoc(out);
    assert.equal(doc.slides.length, 3);
    assert.equal(doc.slides[2].images.length, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('validatePptxTemplateOutput：檢查 layout 與圖片 relationship 完整性', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-verify-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const img = join(cwd, 'logo.png');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makePptxTemplate({ picture: true }));
    writeFileSync(img, PNG_1X1);
    generatePptxFromTemplate(tpl, out, [{ title: '圖文', body: ['說明'], images: [img] }]);
    const ok = validatePptxTemplateOutput(out);
    assert.equal(ok.ok, true);
    assert.equal(ok.slides, 1);
    assert.equal(ok.images, 1);
    assert.equal(typeof ok.design.score, 'number');
    assert.equal(ok.design.slides.length, 1);
    assert.deepEqual(ok.layouts, ['Title and Content']);

    const broken = join(cwd, 'broken.pptx');
    const buf = makeZip([...readZipEntries(out)].filter((f) => f.name !== 'ppt/media/image1.png'));
    writeFileSync(broken, buf);
    const bad = validatePptxTemplateOutput(broken);
    assert.equal(bad.ok, false);
    assert.match(bad.issues.map((i) => i.message).join('\n'), /圖片 relationship 目標不存在/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('validatePptxTemplateOutput：回傳 PPT 設計品質分數與風險', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pptx-template-design-'));
  try {
    const tpl = join(cwd, 'template.pptx');
    const img = join(cwd, 'logo.png');
    const out = join(cwd, 'out.pptx');
    writeFileSync(tpl, makePptxTemplate({ picture: true }));
    writeFileSync(img, PNG_1X1);
    const body = Array.from({ length: 10 }, (_, i) => `這是第 ${i + 1} 個過長的重點，會讓同一張投影片的閱讀密度變高`);
    generatePptxFromTemplate(tpl, out, [{
      title: '這是一個非常非常長的投影片標題，應該被設計驗證標記為風險，並提示需要拆短',
      body,
      images: [img],
    }]);
    const verify = validatePptxTemplateOutput(out);
    assert.equal(verify.ok, true);
    assert.equal(verify.design.ok, false);
    assert.ok(verify.design.score < 100);
    assert.match(verify.design.issues.map((i) => i.code).join('\n'), /title-too-long/);
    assert.match(verify.design.issues.map((i) => i.code).join('\n'), /body-too-dense/);
    assert.equal(verify.design.slides[0].metrics.bodyLines, 10);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('isValidDoc：依格式驗證（html 有標籤 / pdf 魔數 / csv 非空 / 缺檔 false）', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-val-'));
  try {
    writeFileSync(join(cwd, 'a.html'), '<!doctype html><html></html>');
    writeFileSync(join(cwd, 'bad.pdf'), 'not a pdf');
    writeFileSync(join(cwd, 'd.csv'), 'a,b\n1,2');
    assert.equal(isValidDoc(join(cwd, 'a.html')), true);
    assert.equal(isValidDoc(join(cwd, 'bad.pdf')), false);   // 非 %PDF
    assert.equal(isValidDoc(join(cwd, 'd.csv')), true);
    assert.equal(isValidDoc(join(cwd, 'nope.html')), false); // 缺檔
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('docgen verify 徽章：產出文件後 result.verify.ok（完成定義）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-badge-'));
  try {
    const k = createKernel(createDocgenPack({ cwd }), {
      cwd, model: FAKE_MODEL, getApiKey: () => 'k',
      streamFn: fakeProvider([toolMsg('gen_doc', { path: 'r.html', markdown: '# 報告\n\n內容' }), textMsg('完成')]),
    });
    const r = await k.runTurn('產一份報告');
    assert.ok(r.verify, 'result.verify 應存在');
    assert.equal(r.verify.ran, true);
    assert.equal(r.verify.ok, true);
    assert.match(r.verify.output, /有效/);
    assert.ok(existsSync(join(cwd, 'r.html')));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('gen_doc 工具：經 kernel 產出文件', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn3-'));
  try {
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    assert.ok(k.registry.has('gen_doc'));
    const res = JSON.parse((await k.runTool('gen_doc', { path: 'out.html', markdown: '# 你好\n\n世界' })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.equal(res.quality.ok, true);
    assert.equal(res.quality.grade, 'pass');
    assert.equal(res.quality.artifact, 'document');
    assert.equal(typeof res.quality.timingsMs.total, 'number');
    assert.ok(existsSync(join(cwd, 'out.html')));
    assert.match(readFileSync(join(cwd, 'out.html'), 'utf8'), /你好[\s\S]*世界/);
    const meta = readArtifactMetadata(cwd, join(cwd, 'out.html'));
    assert.equal(meta.artifact, 'document');
    assert.equal(meta.quality.grade, 'pass');
    assert.equal(meta.verify.ok, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('gen_doc 工具：Excel 產物帶 quality 成果摘要', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-tool-xlsx-quality-'));
  try {
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    const res = JSON.parse((await k.runTool('gen_doc', {
      path: 'book.xlsx',
      markdown: '# 銷售\n\n| 月 | 金額 |\n| --- | --- |\n| 一月 | 10 |',
    })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.equal(res.format, 'xlsx');
    assert.equal(res.quality.ok, true);
    assert.equal(res.quality.grade, 'pass');
    assert.equal(res.quality.score, 100);
    assert.equal(res.quality.issueCount, 0);
    assert.equal(typeof res.quality.timingsMs.generate, 'number');
    assert.ok(existsSync(join(cwd, 'book.xlsx')));
    const meta = readArtifactMetadata(cwd, join(cwd, 'book.xlsx'));
    assert.equal(meta.format, 'xlsx');
    assert.equal(meta.quality.ok, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('office_capabilities 工具：經 docgen pack 回傳能力矩陣', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-caps-'));
  try {
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    assert.ok(k.registry.has('office_capabilities'));
    const res = JSON.parse((await k.runTool('office_capabilities', {})).result.content[0].text);
    assert.equal(res.read.docx, 'built-in');
    assert.equal(res.write.xlsx, 'built-in');
    assert.ok(res.write.docx === 'docx-native' || res.write.docx === 'pandoc' || res.write.docx === 'soffice' || res.write.docx === false);
    assert.ok(res.write.pptx === 'pptx-native' || res.write.pptx === 'soffice' || res.write.pptx === false);
    assert.equal(typeof res.tools.pandoc, 'boolean');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('analyze_pptx_template 工具：經 docgen pack 回傳模板 manifest', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-template-tool-'));
  try {
    writeFileSync(join(cwd, 'template.pptx'), makePptxTemplate());
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    assert.ok(k.registry.has('analyze_pptx_template'));
    const res = JSON.parse((await k.runTool('analyze_pptx_template', { path: 'template.pptx' })).result.content[0].text);
    assert.equal(res.kind, 'pptx-template');
    assert.equal(res.layouts[0].placeholders[0].type, 'title');
    assert.equal(res.layouts[0].placeholders[1].type, 'body');
    assert.deepEqual(res.theme.colors, ['#1F4E79', '#F2F2F2']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generate_pptx_from_template 工具：經 docgen pack 依模板產生 PPTX', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-template-gen-tool-'));
  try {
    writeFileSync(join(cwd, 'template.pptx'), makePptxTemplate());
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    assert.ok(k.registry.has('generate_pptx_from_template'));
    const res = JSON.parse((await k.runTool('generate_pptx_from_template', {
      template: 'template.pptx',
      path: 'out.pptx',
      slides: [{ title: '模板頁', body: ['保留版式'] }],
    })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.equal(res.quality.ok, true);
    assert.equal(res.quality.grade, 'pass');
    assert.equal(res.quality.repairCount, 0);
    assert.ok(existsSync(join(cwd, 'out.pptx')));
    const meta = readArtifactMetadata(cwd, join(cwd, 'out.pptx'));
    assert.equal(meta.artifact, 'pptx-template');
    assert.equal(meta.quality.grade, 'pass');
    assert.equal(meta.verify.ok, true);
    const doc = extractDoc(join(cwd, 'out.pptx'));
    assert.equal(doc.slides[0].title, '模板頁');
    assert.deepEqual(doc.slides[0].body, ['保留版式']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generate_pptx_from_template 工具：支援 slides.images 相對路徑', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-template-img-tool-'));
  try {
    writeFileSync(join(cwd, 'template.pptx'), makePptxTemplate({ picture: true }));
    writeFileSync(join(cwd, 'logo.png'), PNG_1X1);
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    const res = JSON.parse((await k.runTool('generate_pptx_from_template', {
      template: 'template.pptx',
      path: 'out.pptx',
      slides: [{ title: '圖文頁', body: ['相對路徑圖片'], images: ['logo.png'] }],
    })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.equal(res.images, 1);
    const doc = extractDoc(join(cwd, 'out.pptx'));
    assert.equal(doc.slides[0].images.length, 1);
    assert.equal(doc.slides[0].images[0].name, 'image1.png');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generate_pptx_from_template 工具：自動修正設計風險後再驗證', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-template-design-repair-tool-'));
  try {
    writeFileSync(join(cwd, 'template.pptx'), makePptxTemplate({ picture: true }));
    writeFileSync(join(cwd, 'logo.png'), PNG_1X1);
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    const body = Array.from({ length: 10 }, (_, i) => `這是第 ${i + 1} 個過長的重點，會讓投影片太擁擠`);
    const res = JSON.parse((await k.runTool('generate_pptx_from_template', {
      template: 'template.pptx',
      path: 'out.pptx',
      slides: [{
        title: '這是一個非常非常長的投影片標題，應該先被工具層自動縮短，避免版面換行過多',
        body,
        images: ['logo.png'],
      }],
    })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.equal(res.repaired, true);
    assert.equal(res.slides, 3);
    assert.equal(res.quality.ok, true);
    assert.equal(res.quality.grade, 'pass');
    assert.equal(res.quality.repairCount, 2);
    assert.equal(typeof res.quality.timingsMs.total, 'number');
    assert.ok(res.quality.timingsMs.total >= res.quality.timingsMs.generate);
    assert.match(res.repairs.map((r) => r.code).join('\n'), /title-shortened/);
    assert.match(res.repairs.map((r) => r.code).join('\n'), /visual-split/);
    assert.equal(res.verify.ok, true);
    assert.equal(res.verify.design.ok, true);
    const doc = extractDoc(join(cwd, 'out.pptx'));
    assert.equal(doc.slides.length, 3);
    assert.equal(doc.slides[0].body.length, 5);
    assert.equal(doc.slides[1].body.length, 5);
    assert.equal(doc.slides[2].body.length, 0);
    assert.equal(doc.slides[2].images.length, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('validate_pptx_template_output 工具：經 docgen pack 驗證 PPTX 輸出', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-template-verify-tool-'));
  try {
    writeFileSync(join(cwd, 'template.pptx'), makePptxTemplate({ picture: true }));
    writeFileSync(join(cwd, 'logo.png'), PNG_1X1);
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    await k.runTool('generate_pptx_from_template', {
      template: 'template.pptx',
      path: 'out.pptx',
      slides: [{ title: '圖文頁', body: ['驗證'], images: ['logo.png'] }],
    });
    assert.ok(k.registry.has('validate_pptx_template_output'));
    const res = JSON.parse((await k.runTool('validate_pptx_template_output', { path: 'out.pptx' })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.equal(res.slides, 1);
    assert.equal(res.images, 1);
    assert.deepEqual(res.layouts, ['Title and Content']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generate_pptx_from_template 工具：支援 slides.tables 表格 placeholder', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-template-table-tool-'));
  try {
    writeFileSync(join(cwd, 'template.pptx'), makeTablePptxTemplate());
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    const res = JSON.parse((await k.runTool('generate_pptx_from_template', {
      template: 'template.pptx',
      path: 'out.pptx',
      slides: [{
        title: '營收表',
        tables: [{ name: 'Revenue', rows: [['季度', '金額'], ['Q1', '100']] }],
      }],
    })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.equal(res.tables, 1);
    assert.equal(res.verify.tables, 1);
    const verify = JSON.parse((await k.runTool('validate_pptx_template_output', { path: 'out.pptx' })).result.content[0].text);
    assert.equal(verify.ok, true);
    assert.equal(verify.tables, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generate_pptx_from_template 工具：支援 slides.charts 圖表 placeholder', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-template-chart-tool-'));
  try {
    writeFileSync(join(cwd, 'template.pptx'), makeChartPptxTemplate());
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    const res = JSON.parse((await k.runTool('generate_pptx_from_template', {
      template: 'template.pptx',
      path: 'out.pptx',
      slides: [{
        title: '營收圖',
        charts: [{ name: 'Revenue', categories: ['Q1', 'Q2'], values: [100, 120] }],
      }],
    })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.equal(res.charts, 1);
    assert.equal(res.verify.charts, 1);
    const verify = JSON.parse((await k.runTool('validate_pptx_template_output', { path: 'out.pptx' })).result.content[0].text);
    assert.equal(verify.ok, true);
    assert.equal(verify.charts, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generate_pptx_from_template 工具：支援 line chart 多系列 rows', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-template-chart-series-tool-'));
  try {
    writeFileSync(join(cwd, 'template.pptx'), makeChartPptxTemplate());
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    const res = JSON.parse((await k.runTool('generate_pptx_from_template', {
      template: 'template.pptx',
      path: 'out.pptx',
      slides: [{
        title: '趨勢圖',
        charts: [{ name: 'Trend', type: 'line', rows: [['季度', 'North', 'South'], ['Q1', '100', '80'], ['Q2', '120', '90']] }],
      }],
    })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.equal(res.charts, 1);
    const raw = readFileSync(join(cwd, 'out.pptx'), 'latin1');
    assert.match(raw, /<c:lineChart>/);
    assert.match(raw, /<c:v>North<\/c:v>/);
    assert.match(raw, /<c:v>South<\/c:v>/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
