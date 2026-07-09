import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const web = (name) => readFileSync(join(here, '../src/app/web', name), 'utf8');

test('Office 預覽 renderer/css 由三個 web 入口共用', () => {
  for (const name of ['index.html', 'chat.html', 'room.html']) {
    const html = web(name);
    assert.match(html, /shared\/office-preview\.css/);
    assert.match(html, /shared\/office-preview\.js/);
    assert.doesNotMatch(html, /function officeTable\(/);
    assert.doesNotMatch(html, /function officeSheetMeta\(/);
  }
});

test('Office 預覽共用 renderer 暴露 renderOfficePreview 且自帶 HTML escape', () => {
  const js = web('shared/office-preview.js');
  assert.match(js, /window\.renderOfficePreview\s*=/);
  assert.match(js, /escOffice/);
  assert.match(js, /doc\.kind === "xlsx"/);
  assert.match(js, /formulas/);
  assert.match(js, /merges/);
  assert.match(js, /function renderQualitySummary/);
});

test('Office 預覽共用 renderer 對多工作表 XLSX 產生 tabs', () => {
  const js = web('shared/office-preview.js');
  const css = web('shared/office-preview.css');
  assert.match(js, /function renderWorkbook/);
  assert.match(js, /officePreviewShowSheet/);
  assert.match(js, /role="tablist"/);
  assert.match(js, /data-office-sheet/);
  assert.match(css, /\.office-tabs/);
  assert.match(css, /\.office-tab\.active/);
});

test('Office 預覽共用 renderer 對 PPTX 產生投影片縮圖導覽', () => {
  const js = web('shared/office-preview.js');
  const css = web('shared/office-preview.css');
  assert.match(js, /function renderDeck/);
  assert.match(js, /function renderSlide/);
  assert.match(js, /function slideLayoutClass/);
  assert.match(js, /function slideMeta/);
  assert.match(js, /slide\.title/);
  assert.match(js, /slide\.body/);
  assert.match(js, /slide\.images/);
  assert.match(js, /slide\.tables/);
  assert.match(js, /slide\.charts/);
  assert.match(js, /function renderChartSummary/);
  assert.match(js, /doc\.warnings/);
  assert.match(js, /office-slide-stage/);
  assert.match(js, /office-deck-rail/);
  assert.match(js, /office-slide-figure/);
  assert.match(js, /office-slide-media-omitted/);
  assert.match(js, /officePreviewShowSlide/);
  assert.match(js, /data-office-slide/);
  assert.match(css, /\.office-deck-rail/);
  assert.match(css, /\.office-slide-stage/);
  assert.match(css, /\.office-slide-layout-media \.office-slide-content/);
  assert.match(css, /\.office-slide-layout-data \.office-slide-content/);
  assert.match(css, /\.office-slide-thumbs/);
  assert.match(css, /\.office-slide-thumb\.active/);
  assert.match(css, /\.office-slide-card/);
  assert.match(css, /\.office-slide-content/);
  assert.match(css, /\.office-slide-figure/);
  assert.match(css, /\.office-slide-media/);
  assert.match(css, /\.office-slide-media-omitted/);
  assert.match(css, /\.office-slide-data-zone/);
  assert.match(css, /\.office-slide-tables/);
  assert.match(css, /\.office-chart-summary/);
  assert.match(css, /\.office-warning/);
});

test('Office 預覽共用 renderer 顯示生成品質與設計檢查摘要', () => {
  const js = web('shared/office-preview.js');
  const css = web('shared/office-preview.css');
  assert.match(js, /doc\?\.quality/);
  assert.match(js, /doc\?\.verify/);
  assert.match(js, /quality\?\.grade/);
  assert.match(js, /quality\?\.score/);
  assert.match(js, /quality\?\.repairCount/);
  assert.match(js, /quality\?\.issueCount/);
  assert.match(js, /quality\?\.timingsMs\?\.total/);
  assert.match(js, /design\?\.issues/);
  assert.match(js, /office-quality-/);
  assert.match(js, /已自動修正/);
  assert.match(js, /設計檢查/);
  assert.match(css, /\.office-quality/);
  assert.match(css, /\.office-quality-pass/);
  assert.match(css, /\.office-quality-warn/);
  assert.match(css, /\.office-quality-fail/);
  assert.match(css, /\.office-quality-metrics/);
  assert.match(css, /\.office-quality-detail/);
});
