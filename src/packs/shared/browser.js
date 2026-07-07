// headless 瀏覽器截圖 — 給 uiux pack「視覺自檢」：把 agent 產出的 HTML 開起來全頁截圖，
// 回報實際渲染尺寸、橫向溢出、console 錯誤、載入失敗的資源，讓 agent 對照修正
//（frontend-design：a picture is worth 1000 tokens）。
//
// Playwright 是重相依（要瀏覽器二進位），所以：① 動態 import，未裝時優雅回報安裝指引，不炸
// ② launcher 可注入（deps.launch），核心編排邏輯用 fake 瀏覽器即可單元測試，不需真的裝瀏覽器。
import { pathToFileURL } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, basename } from 'node:path';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

// 預設 launcher：動態 import playwright → 啟動 chromium；找不到瀏覽器則退回系統 Chrome channel。
async function defaultLaunch() {
  let pw;
  try { pw = await import('playwright'); }
  catch {
    try { pw = await import('playwright-core'); }
    catch { const e = new Error('未安裝 playwright'); e.install = 'npm i -D playwright && npx playwright install chromium'; throw e; }
  }
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  if (!chromium) { const e = new Error('playwright 缺 chromium 介面'); e.install = 'npm i -D playwright'; throw e; }
  try { return await chromium.launch({ headless: true }); }
  catch {
    try { return await chromium.launch({ headless: true, channel: 'chrome' }); } // 退回系統 Chrome
    catch { const e = new Error('playwright 已裝但找不到瀏覽器'); e.install = 'npx playwright install chromium'; throw e; }
  }
}

// 截一張全頁圖。target: { url } | { file 絕對路徑 } | { html 內容 }。
// 回 { ok, screenshot, rendered:{width,height}, viewport, overflowX, consoleErrors, failedResources }
// 或 { ok:false, reason, install? }（未裝/失敗皆優雅回報，不丟例外）。
export async function capturePage(target, opts = {}, deps = {}) {
  const { outPath, viewport = { width: 1280, height: 800 }, timeoutMs = 30000, fullPage = true } = opts;
  const launch = deps.launch || defaultLaunch;
  let browser;
  try { browser = await launch(); }
  catch (e) { return { ok: false, reason: e.message, install: e.install }; }
  const consoleErrors = []; const failedResources = [];
  try {
    const page = await browser.newPage({ viewport });
    page.on('console', (m) => { try { if (m.type() === 'error') consoleErrors.push(m.text()); } catch { /* 略 */ } });
    page.on('pageerror', (err) => consoleErrors.push(String((err && err.message) || err)));
    page.on('requestfailed', (req) => { try { failedResources.push(req.url()); } catch { /* 略 */ } });
    const nav = { waitUntil: 'networkidle', timeout: timeoutMs };
    if (target.url) await page.goto(target.url, nav);
    else if (target.file) await page.goto(pathToFileURL(target.file).href, nav);
    else if (target.html != null) await page.setContent(target.html, nav);
    else return { ok: false, reason: '沒有截圖目標（url / file / html 三選一）' };
    const dims = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
      vw: window.innerWidth, vh: window.innerHeight,
    }));
    if (outPath) { try { mkdirSync(dirname(outPath), { recursive: true }); } catch { /* 略 */ } }
    await page.screenshot({ path: outPath, fullPage });
    return {
      ok: true, screenshot: outPath,
      rendered: { width: dims.width, height: dims.height }, viewport,
      overflowX: dims.width > dims.vw + 1, // 頁面比視窗寬 → 橫向溢出（常見版面 bug）
      consoleErrors, failedResources,
    };
  } catch (e) { return { ok: false, reason: '截圖失敗：' + (e.message || String(e)) }; }
  finally { try { await browser.close(); } catch { /* 略 */ } }
}

// 共用「截圖」工具工廠——uiux（視覺自檢）/ coding（看 JS 渲染、E2E 前置）/ general（抓 SPA）皆可用。
// 輸出限 cwd 內（沙箱）；預設存到 .xitto-preview/。
export function createScreenshotTool(cwd = process.cwd()) {
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));
  const within = (p) => { const full = abs(p); const r = relative(cwd, full); return (r === '' || (!r.startsWith('..') && !isAbsolute(r))) ? full : null; };
  return {
    name: 'screenshot', label: '截圖', readOnly: true,
    description: '把一個本機 HTML 檔（相對路徑）或 http(s) URL 用 headless 瀏覽器開啟並「全頁截圖」存檔，回傳圖片路徑、實際渲染尺寸、是否橫向溢出、console 錯誤、載入失敗的資源。可看 JS 渲染後的真實畫面（比 web_fetch 抓 SPA 準）、或產出/改完 UI 後自己看一眼對照修正（a picture is worth 1000 tokens）。需安裝 playwright（未裝會提示怎麼裝）。',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '要截圖的本機 HTML 檔（相對 cwd）；與 url 二選一' },
      url: { type: 'string', description: 'http(s) 網址；與 path 二選一' },
      out: { type: 'string', description: '輸出 PNG 路徑（相對 cwd），預設 .xitto-preview/<name>.png' },
      width: { type: 'number', description: '視窗寬度，預設 1280' },
      height: { type: 'number', description: '視窗高度，預設 800' },
    } },
    execute: async (_id, { path, url, out, width, height } = {}) => {
      let target;
      if (url) { if (!/^https?:\/\//i.test(url)) return txt({ error: 'url 需為 http(s)' }); target = { url }; }
      else if (path) { const p = abs(path); if (!existsSync(p)) return txt({ error: '檔案不存在', path }); target = { file: p }; }
      else return txt({ error: '需給 path 或 url' });
      const rel = out || join('.xitto-preview', (path ? basename(path).replace(/\.html?$/i, '') : 'page') + '.png');
      const outAbs = within(rel);
      if (!outAbs) return txt({ error: '輸出路徑須在工作目錄內', out: rel });
      const r = await capturePage(target, { cwd, outPath: outAbs, viewport: { width: width || 1280, height: height || 800 } });
      if (!r.ok) return txt({ ok: false, reason: r.reason, ...(r.install ? { hint: `安裝後即可使用：${r.install}` } : {}) });
      return txt({
        ok: true, screenshot: relative(cwd, outAbs), rendered: r.rendered, viewport: r.viewport,
        overflowX: r.overflowX, consoleErrors: r.consoleErrors.slice(0, 20), failedResources: r.failedResources.slice(0, 20),
        ...(r.overflowX ? { note: '頁面橫向溢出——通常是寬內容沒包 overflow-x 或有固定寬度元素；修掉再截一次。' } : {}),
      });
    },
  };
}
