// uiux agent EvalSuite —— 對標 v0「交付生產級、可及、響應式的介面」。
// 每題給設計需求 → agent 產出前端檔 → scorer 用 uiux 的 a11y 靜態檢查（auditHtml，0 問題=可及）
// + 結構檢查（語意/響應式/互動態是否齊全）打分。可量化的「高水準」標準。
// node eval/uiux-run.js
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadModel } from '../src/app/providers.js';
import { createUiuxPack, auditHtml, auditAssets } from '../src/packs/uiux/index.js';
import { runSuite, allOf } from './framework.js';

// 遞迴收集 dir 下的 HTML 路徑（排除依賴/產物目錄；模型有時會把檔寫進相對子路徑）。
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage']);
function htmlPaths(dir, depth = 0, acc = []) {
  if (depth > 5 || acc.length >= 40) return acc;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) htmlPaths(p, depth + 1, acc); }
    else if (/\.html?$/i.test(e.name)) acc.push(p);
  }
  return acc;
}
const readSafe = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

// scorer：可及（所有 HTML 經 auditHtml 0 問題，且至少有一個檔）。
const a11yClean = ({ dir }) => { const ps = htmlPaths(dir); return ps.length > 0 && ps.every((p) => auditHtml(readSafe(p), 'x').length === 0); };
// scorer：執行期 OK（沒有壞掉的本地資產引用、引入的 JS 無裸佔位符）。
const assetsOk = ({ dir }) => htmlPaths(dir).every((p) => auditAssets(readSafe(p), p).length === 0);
// scorer：合併全部 HTML 後，每條 regex 都命中（結構/響應式/互動態檢查）。
const has = (...res) => ({ dir }) => { const all = htmlPaths(dir).map(readSafe).join('\n'); return res.every((re) => re.test(all)); };

const tasks = [
  {
    id: 'contact-form（語意表單 + a11y）',
    goal: '建立 index.html：一個聯絡表單，欄位有姓名、Email、訊息，加送出按鈕。要可及性正確（每欄有 label、html 有 lang、有 viewport）、響應式。',
    score: allOf(a11yClean, has(/<form/i, /<label/i, /<input/i, /name=["']?viewport/i)),
  },
  {
    id: 'icon-toolbar（圖示按鈕要 aria-label）',
    goal: '建立 toolbar.html：一排只有圖示（沒有文字）的工具列按鈕，例如搜尋、設定、刪除。確保每個圖示按鈕對螢幕報讀器可用。',
    score: allOf(a11yClean, has(/<button/i, /aria-label/i)),
  },
  {
    id: 'responsive-cards（響應式 + focus 態）',
    goal: '建立 cards.html：一個產品卡片網格，桌面多欄、手機單欄。卡片可點擊，要有清楚的 hover 與鍵盤 focus 樣式。',
    score: allOf(a11yClean, has(/@media/i, /:focus/i, /(grid|flex)/i)),
  },
  {
    id: 'fix-a11y（修不可及頁面）',
    setup: {
      'page.html': '<html><head><title>x</title></head><body><div onclick="open()">🔍</div><img src="a.png"><input type="text"></body></html>',
    },
    goal: 'page.html 有可及性問題（缺 lang、缺 viewport、圖示用 div+onclick、img 缺 alt、input 缺 label）。請修正成符合 WCAG AA 的版本。',
    score: a11yClean,
  },
  {
    id: 'refactor-no-break（抽離資產不破壞執行期）',
    setup: {
      'index.html': '<!doctype html><html lang="zh-Hant"><head><meta name="viewport" content="width=device-width">\n<style>body{font-family:system-ui;margin:0}.btn{padding:8px 16px}</style></head>\n<body><main><h1>標題</h1><button class="btn" type="button">動作</button></main>\n<script>document.querySelector(".btn").addEventListener("click",()=>alert("hi"))</script></body></html>',
    },
    goal: '重構 index.html：把 inline <style> 抽到 styles.css 並用 <link> 引入、把 inline <script> 抽到 app.js 並用 <script src> 引入。行為與外觀不變，確保頁面仍能正常載入（引用路徑正確、沒有壞掉）。',
    // 抽離後：可及性仍 0 問題，且資產引用都解析得到（styles.css/app.js 存在、無壞引用）。
    score: allOf(a11yClean, assetsOk, has(/<link[^>]+href=["'][^"']*\.css/i, /<script[^>]+src=["'][^"']*\.js/i)),
  },
];

const { model, getApiKey } = loadModel();
await runSuite({ name: 'xitto-kernel · uiux agent', pack: (dir) => createUiuxPack({ cwd: dir }), tasks, model, getApiKey, sandbox: false, maxRounds: 5 });
process.exit(0);
