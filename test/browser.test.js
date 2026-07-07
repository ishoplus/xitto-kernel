// headless 截圖（browser.capturePage）+ uiux pack 的 ui_screenshot 工具。
// 用 fake 瀏覽器（依賴注入）測核心編排，不需真的裝 playwright；另測未裝時的優雅退場與工具 guard。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePage } from '../src/packs/shared/browser.js';
import { createUiuxPack } from '../src/packs/uiux/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

// fake launcher：回一個假瀏覽器，goto/setContent 時觸發預設的 console/pageerror/requestfailed。
function fakeLaunch({ consoleError, pageError, failedReq, dims } = {}) {
  return async () => ({
    async newPage() {
      const h = {};
      const emit = () => {
        if (consoleError) (h.console || []).forEach((f) => f({ type: () => 'error', text: () => consoleError }));
        if (pageError) (h.pageerror || []).forEach((f) => f(new Error(pageError)));
        if (failedReq) (h.requestfailed || []).forEach((f) => f({ url: () => failedReq }));
      };
      return {
        on(ev, fn) { (h[ev] ||= []).push(fn); },
        async goto() { emit(); },
        async setContent() { emit(); },
        async evaluate() { return dims || { width: 1280, height: 700, vw: 1280, vh: 800 }; },
        async screenshot({ path }) { writeFileSync(path, Buffer.from('\x89PNG-FAKE')); },
      };
    },
    async close() {},
  });
}

test('capturePage（fake）：截圖存檔 + 回報尺寸/console/資源', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot-'));
  try {
    const out = join(dir, '.xitto-preview', 'p.png');
    const r = await capturePage({ html: '<h1>hi</h1>' }, { cwd: dir, outPath: out },
      { launch: fakeLaunch({ consoleError: 'Uncaught TypeError: x', failedReq: 'http://x/missing.js' }) });
    assert.equal(r.ok, true);
    assert.ok(existsSync(out), '截圖檔應寫出');
    assert.equal(r.rendered.width, 1280);
    assert.equal(r.overflowX, false);              // 1280 <= vw 1280
    assert.deepEqual(r.consoleErrors, ['Uncaught TypeError: x']);
    assert.deepEqual(r.failedResources, ['http://x/missing.js']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('capturePage（fake）：頁面比視窗寬 → overflowX=true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot2-'));
  try {
    const r = await capturePage({ html: '<div style="width:2000px">x</div>' }, { cwd: dir, outPath: join(dir, 'o.png') },
      { launch: fakeLaunch({ dims: { width: 2000, height: 700, vw: 1280, vh: 800 } }) });
    assert.equal(r.ok, true);
    assert.equal(r.overflowX, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('capturePage：launcher 失敗（未裝）→ 優雅回報 install，不丟例外', async () => {
  const r = await capturePage({ html: '<p>x</p>' }, {}, { launch: async () => { const e = new Error('未安裝 playwright'); e.install = 'npm i -D playwright'; throw e; } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /未安裝/);
  assert.equal(r.install, 'npm i -D playwright');
});

test('capturePage：沒有目標（url/file/html）→ ok:false', async () => {
  const r = await capturePage({}, {}, { launch: fakeLaunch() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /url.*file.*html|三選一/);
});

test('screenshot 工具：三個 pack（uiux/coding/general）皆註冊', () => {
  for (const make of [createUiuxPack, createCodingPack, createGeneralPack]) {
    assert.ok(make({ cwd: '/tmp' }).tools().map((t) => t.name).includes('screenshot'), `${make.name} 應有 screenshot 工具`);
  }
});

test('screenshot 工具：guard（缺 path/url、非法 url、檔不存在）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot3-'));
  try {
    const tool = createUiuxPack({ cwd: dir }).tools().find((t) => t.name === 'screenshot');
    assert.ok(tool, '應有 screenshot 工具');
    assert.match(JSON.parse((await tool.execute('1', {})).content[0].text).error, /需給 path 或 url/);
    assert.match(JSON.parse((await tool.execute('2', { url: 'ftp://x' })).content[0].text).error, /http/);
    assert.match(JSON.parse((await tool.execute('3', { path: 'nope.html' })).content[0].text).error, /不存在/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('screenshot 工具：playwright 未裝 → ok:false + 安裝提示（真實路徑）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot4-'));
  try {
    writeFileSync(join(dir, 'page.html'), '<!doctype html><h1>hi</h1>');
    const tool = createUiuxPack({ cwd: dir }).tools().find((t) => t.name === 'screenshot');
    const r = JSON.parse((await tool.execute('1', { path: 'page.html' })).content[0].text);
    // 此環境沒裝 playwright → 應優雅回報；若剛好裝了則 ok:true 也可接受
    if (!r.ok) { assert.match(r.reason, /playwright/i); assert.match(r.hint, /playwright/i); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
