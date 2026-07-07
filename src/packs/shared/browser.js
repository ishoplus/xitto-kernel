// headless 瀏覽器截圖 — 給 uiux pack「視覺自檢」：把 agent 產出的 HTML 開起來全頁截圖，
// 回報實際渲染尺寸、橫向溢出、console 錯誤、載入失敗的資源，讓 agent 對照修正
//（frontend-design：a picture is worth 1000 tokens）。
//
// Playwright 是重相依（要瀏覽器二進位），所以：① 動態 import，未裝時優雅回報安裝指引，不炸
// ② launcher 可注入（deps.launch），核心編排邏輯用 fake 瀏覽器即可單元測試，不需真的裝瀏覽器。
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
