// docgen：md → 可列印 HTML（零相依、中文 OK）；generateDoc 寫檔；.pdf 走渲染器或 fallback HTML；
// gen_doc 工具經 kernel 產出成品。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mdToHtml, mdToBody, generateDoc, mdTableToRows, toCsv } from '../src/packs/shared/doc-gen.js';
import { createKernel } from '../src/kernel/index.js';
import { createDocgenPack } from '../src/packs/docgen/index.js';

const MD = `# 季度報告\n\n這是**重點**與 \`code\`。\n\n- 項目一\n- 項目二\n\n| 名稱 | 數量 |\n| --- | --- |\n| 甲 | 1 |\n\n> 引言一句。`;

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

test('generateDoc：.html → 寫出有效 HTML 檔', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-'));
  try {
    const out = join(cwd, 'r.html');
    const r = generateDoc(MD, out, { title: '報告' });
    assert.equal(r.ok, true);
    assert.equal(r.format, 'html');
    assert.ok(existsSync(out));
    assert.match(readFileSync(out, 'utf8'), /<!doctype html>[\s\S]*季度報告/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.pdf → PDF（有渲染器）或 fallback HTML（無）；兩者皆 ok', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn2-'));
  try {
    const out = join(cwd, 'r.pdf');
    const r = generateDoc(MD, out, { title: '報告' });
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

test('generateDoc：.docx → Word（有 pandoc/soffice）或 fallback HTML（無）；兩者皆 ok', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-docx-'));
  try {
    const out = join(cwd, 'r.docx');
    const r = generateDoc(MD, out, { title: '報告' });
    assert.equal(r.ok, true);
    if (r.format === 'docx') {
      assert.ok(existsSync(out));
      assert.equal(readFileSync(out).subarray(0, 2).toString(), 'PK', 'docx 應為 ZIP(PK) 容器');
      assert.ok(r.tool);
    } else {
      assert.equal(r.format, 'html');
      assert.ok(existsSync(join(cwd, 'r.html')));
      assert.match(r.note, /docx|DOCX|HTML/i);
    }
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

test('generateDoc：.csv → 零相依寫出（UTF-8 BOM + 中文）', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-csv-'));
  try {
    const out = join(cwd, 'data.csv');
    const r = generateDoc('| 名稱 | 數量 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |', out);
    assert.equal(r.ok, true);
    assert.equal(r.format, 'csv');
    assert.equal(r.rows, 3);
    const buf = readFileSync(out);
    assert.equal(buf.subarray(0, 3).toString('hex'), 'efbbbf', '應有 UTF-8 BOM（Excel 中文）');
    assert.match(buf.toString('utf8'), /名稱,數量[\s\S]*甲,1/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('generateDoc：.csv 無表格 → ok:false + 提示', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn-csv2-'));
  try {
    const r = generateDoc('這只是一段文字，沒有表格。', join(cwd, 'x.csv'));
    assert.equal(r.ok, false);
    assert.match(r.note, /表格|GFM/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('gen_doc 工具：經 kernel 產出文件', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dgn3-'));
  try {
    const k = createKernel(createDocgenPack({ cwd }), { cwd });
    assert.ok(k.registry.has('gen_doc'));
    const res = JSON.parse((await k.runTool('gen_doc', { path: 'out.html', markdown: '# 你好\n\n世界' })).result.content[0].text);
    assert.equal(res.ok, true);
    assert.ok(existsSync(join(cwd, 'out.html')));
    assert.match(readFileSync(join(cwd, 'out.html'), 'utf8'), /你好[\s\S]*世界/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
