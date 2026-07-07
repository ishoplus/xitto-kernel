// uiux pack — UI/UX 設計與前端介面 agent。
// 與 coding 的分工：會的工具相近（讀寫前端檔、查參考），但「守什麼規矩、怎麼算做完」不同——
// coding 守 lint/型別；uiux 守「設計一致性 + 可及性(a11y) + 響應式 + 視覺層次」，verify 以 a11y 靜態檢查守門。
// 工具：read/ls/glob/grep(探勘既有 UI 與 design token) + web_search/web_fetch(參考設計/元件範式/WCAG) + write/edit + bash(跑 build/格式化/起 dev server)。
import { withBaseRules } from '../shared/prompt.js';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import { createFsTools } from '../shared/fs-tools.js';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';
import { createWebSearchTool, createWebFetchTool } from '../shared/web-tools.js';

const SYSTEM_PROMPT = [
  '你是資深 UI/UX 設計工程師。水準對標 Vercel v0：一句需求就交付「生產級、可及、響應式、有設計系統一致性」的介面（程式碼，不是圖）。準則：',
  '',
  '【對標的具名標準（不是憑感覺）】',
  '- 可及性：WCAG 2.2 AA + WAI-ARIA Authoring Practices（APG）。互動元件照 APG 的鍵盤/角色模式做。',
  '- 視覺工藝：《Refactoring UI》原則——用層次（大小/粗細/顏色）而非「都做大」、限制選擇、留白優先、用真實內容測試。',
  '- 間距/尺寸：8pt（或 4pt）grid，token 化，不用魔術數字。',
  '- 效能體驗：留意 Core Web Vitals（LCP/INP/CLS）——別塞巨圖、避免版面位移、互動要即時回饋。',
  '- 平台規範：需要時參照 Apple HIG / Material Design 3 / Fluent。',
  '',
  '【先對齊，再動手】',
  '- 啟動先讀 contextFile（DESIGN.md／STYLEGUIDE.md）與既有樣式：沿用專案既有的 design token（顏色/間距/字級/圓角/陰影）、元件慣例與框架（純 CSS / Tailwind / styled / React 等），不要另起一套不一致的風格。',
  '- 品牌調性、視覺方向、目標客群或裝置不明確時，用 ask 問使用者，不要自行臆斷視覺風格。',
  '',
  '【改既有檔：不可破壞執行期契約（重要）】',
  '- 美化/重構既有 UI 時，先理解它如何被執行：模板佔位符（如 __FOO__ / {{ }} / <% %>）、被 JS 參照的 id 與 data-* 屬性、外部資產路徑、build/serve 對特定檔的特殊處理。',
  '- 抽離 CSS/JS 到外部檔前，確認那段內容有沒有被後端注入或模板替換——若有，佔位符不能搬到「不會被替換」的靜態檔（會在瀏覽器變成未定義而炸掉）。寧可先 read 後端/server 怎麼供應這頁，或用 ask 確認，也不要憑空搬。',
  '- 重構後務必確認頁面「還能跑」：沒有壞掉的資產引用、沒有未替換的裸佔位符、開瀏覽器沒有 console error——不是只有 markup 漂亮。',
  '',
  '【可及性 a11y（WCAG 2.2 AA，硬底線）】',
  '- 語意化 HTML：用 button/a/nav/main/header/label 等正確標籤，而非 div/span + onclick（後者鍵盤與報讀器都不可用）。',
  '- 每個 <img> 給有意義的 alt（純裝飾用 alt="" 或 aria-hidden）；<html> 標 lang；表單每個控件都要有關聯 <label>（for/id 或包起來）或 aria-label。',
  '- 純圖示的按鈕/連結要有 aria-label 或 title，讓螢幕報讀器念得出。',
  '- 文字與背景對比達 AA（一般文字 ≥ 4.5:1、大字 ≥ 3:1）；不要只靠顏色傳達狀態。',
  '- 可鍵盤操作：互動元件可 focus、有清楚的 :focus-visible 樣式、自然 tab 順序（不要用正值 tabindex）；id 不可重複。ARIA 只在原生語意不足時才加（「沒有 ARIA 勝過錯的 ARIA」）。',
  '',
  '【視覺與互動品質】',
  '- 視覺層次：用大小/粗細/間距/顏色建立主次，而非把每個元素都做大。維持一致的間距節奏（8pt grid）。',
  '- 互動狀態要齊：hover / focus / active / disabled / loading / 空狀態 / 錯誤狀態 都要設計到，別只做「正常」那一態。',
  '- 響應式：mobile-first，加 viewport meta，用相對單位與彈性佈局（grid/flex）；在窄螢幕不破版。',
  '- 動效克制、有目的（過場/回饋），尊重 prefers-reduced-motion。',
  '- 微文案（按鈕/提示/錯誤訊息）清楚、以使用者為中心，講「發生什麼、怎麼辦」。',
  '',
  '【設計方向：要有主張、別套模板（工作室 / v0 水準）】',
  '- 把自己當「給每個客戶做出無法被誤認的識別」的設計主導。需求沒鎖定風格時，先為它定一個具體主題＋受眾＋頁面的單一任務，設計從那個主題的世界（材料、語彙、素材）長出來，並用真實內容而非 lorem 測試。',
  '- Hero 是論點：開場放最能代表這主題的東西（標題／圖／互動片刻）。別反射性用「大數字＋小標＋漸層強調」這種樣板答案，除非它真是最佳解。',
  '- 字體承載個性：刻意配 display＋body（別用你每個專案都會拿的那組），定清楚字級/字重/字距；讓字體處理本身成為記憶點。',
  '- 結構要編碼真實資訊：編號(01/02/03)、eyebrow、分隔線只在內容「確實是序列 / 有意義層級」時才用，別純裝飾。',
  '- 把大膽集中在「一個 signature 元素」——讓它成唯一記憶點，其餘保持安靜克制；拿掉任何不服務主題的裝飾（Chanel：出門前拿掉一件配件）。',
  '- 避開現在 AI 設計的三大 cliché（是「預設」不是「選擇」）：①暖奶油底＋高對比 serif＋赤陶色 ②近黑底＋單一螢光綠/朱紅 ③報紙式 hairline＋零圓角＋密欄。需求沒指定方向時，別把自由花在這些上。',
  '- 兩段式流程：先出精簡設計計畫（4–6 個具名色 token／2+ 字體角色／佈局概念／signature 元素）→ 對照需求自我批判「這是否只是任何類似題都會做的預設」→ 修掉套版處，再依修正後的計畫寫 code。',
  '',
  '【產出與自檢】',
  '- 用 write/edit 產出/修改前端檔；改既有檔前先 read。可用 web_search/web_fetch 找元件範式或 WCAG/APG 準則佐證，關鍵決策說明理由。',
  '- 收尾自我檢查：語意標籤、img alt、表單標籤、對比、focus 樣式、響應式、各互動狀態是否齊全。verify 會以 a11y 靜態檢查（必要時加專案本地 a11y 工具）守門，未過會退回要你補。',
].join('\n');

// 偵測專案是否自備 a11y 檢查腳本（pa11y / axe / lighthouse 等）；有則 verify 一併跑「真檢查」。
// 對齊 coding pack 的 detectVerifyCmd：不在 kernel 綁工具，用專案已配置的。
function detectA11yCmd(cwd) {
  try {
    const pkgPath = join(cwd, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
    const key = Object.keys(scripts).find((k) => /a11y|accessib|lighthouse|pa11y|\baxe\b/i.test(k));
    return key ? `npm run ${key} --silent` : null;
  } catch { return null; }
}

// ── a11y 靜態檢查（零依賴、正則為主，只挑高把握度的 WCAG 問題，避免雜訊讓 agent 忽略）──
const RE_HTML_TAG = /<html(\s[^>]*)?>/i;
const RE_DOCTYPE = /<!doctype\s+html/i;

/** 掃單一 HTML 檔，回傳具體問題字串陣列（空=通過）。 */
export function auditHtml(src, file) {
  const issues = [];
  const isFullDoc = RE_DOCTYPE.test(src) || RE_HTML_TAG.test(src);

  if (isFullDoc) {
    const htmlTag = src.match(RE_HTML_TAG);
    if (htmlTag && !/\blang\s*=/i.test(htmlTag[1] || '')) issues.push('<html> 缺 lang 屬性（螢幕報讀器無法判斷語言）');
    if (/<head[\s>]/i.test(src) && !/<meta[^>]+name\s*=\s*["']?viewport/i.test(src)) issues.push('缺 responsive viewport meta（窄螢幕會破版）');
  }

  // <img> 缺 alt
  const imgs = src.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter((t) => !/\balt\s*=/i.test(t)).length;
  if (noAlt) issues.push(`${noAlt} 個 <img> 缺 alt 屬性`);

  // 純圖示的 button / a：內文沒有可讀文字（字母/數字/中日韓），又沒有 aria-label/title → 報讀器念不出
  const labelless = [];
  for (const m of src.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const attrs = m[2] || '';
    if (/\baria-label\s*=|\btitle\s*=|\baria-labelledby\s*=/i.test(attrs)) continue;
    const inner = m[3].replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, ' ');
    if (/[\p{L}\p{N}]/u.test(inner)) continue;       // 有可讀文字 → 略過
    if (/<img\b[^>]*\balt\s*=\s*["'][^"']/i.test(m[3])) continue; // 內含有 alt 的圖片 → 代為命名
    labelless.push(m[1]);                             // 空殼或只有圖示符號（emoji/svg）→ 需 aria-label
  }
  if (labelless.length) issues.push(`${labelless.length} 個圖示型 <button>/<a> 沒有可讀文字也沒有 aria-label/title`);

  // 非語意互動：<div>/<span> 綁 onclick → 鍵盤/報讀器不可用，應改用 <button>
  const divClick = (src.match(/<(?:div|span)\b[^>]*\bonclick\b/gi) || []).length;
  if (divClick) issues.push(`${divClick} 個 <div>/<span> 綁 onclick——應改用語意化 <button>（否則無法鍵盤操作）`);

  // 正值 tabindex：破壞自然鍵盤 tab 順序（反模式，應只用 0 或 -1）
  const posTab = (src.match(/\btabindex\s*=\s*["']?\s*[1-9]/gi) || []).length;
  if (posTab) issues.push(`${posTab} 處正值 tabindex（破壞鍵盤 tab 順序，應用 0 或 -1）`);

  // 重複 id：a11y（label for/aria 指向錯亂）與 JS 都會出錯
  const ids = [...src.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const dup = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  if (dup.length) issues.push(`重複的 id：${dup.slice(0, 5).join('、')}`);

  // 表單控件缺關聯標籤：既無 aria-label/title，又沒有 <label for> 指到、也不在 <label> 內 → 報讀器念不出欄位
  const forTargets = new Set([...src.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const labelSpans = [...src.matchAll(/<label\b[\s\S]*?<\/label>/gi)].map((m) => [m.index, m.index + m[0].length]);
  const insideLabel = (idx) => labelSpans.some(([a, b]) => idx >= a && idx < b);
  let unlabeled = 0;
  for (const m of src.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const attrs = m[2] || '';
    if (m[1].toLowerCase() === 'input') {
      const t = ((attrs.match(/\btype\s*=\s*["']?([a-z]+)/i) || [])[1] || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(t)) continue; // 這些不需文字標籤
    }
    if (/\baria-label\s*=|\baria-labelledby\s*=|\btitle\s*=/i.test(attrs)) continue;
    const id = (attrs.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (id && forTargets.has(id)) continue;
    if (insideLabel(m.index)) continue;
    unlabeled++;
  }
  if (unlabeled) issues.push(`${unlabeled} 個表單控件沒有關聯 <label>（也沒有 aria-label）`);

  return issues.map((s) => `  [${file}] ${s}`);
}

// 找出「裸」模板佔位符（__UPPER_SNAKE__ 且不在引號內）——當作 JS 識別字用會直接 ReferenceError。
// （引號內的 "__X__" 視為字串字面值，不算；__dirname 等小寫不符。）
const BARE_TOKEN_RE = /(^|[^'"\w])(__[A-Z][A-Z0-9_]*__)(?![\w'"])/g;
export function bareTemplateTokens(text) {
  return [...new Set([...String(text).matchAll(BARE_TOKEN_RE)].map((m) => m[2]))];
}

// 行為感知檢查：解析 HTML 引用的本地資產，抓「會讓頁面跑不起來」的問題——
// ① 引用的本地檔不存在（壞路徑）；② 引入的 JS 含裸佔位符（載入即 ReferenceError，例如把 __PACKS__ 搬進靜態 JS）。
// htmlPath：該 HTML 的絕對路徑，用來解析相對 src/href。
export function auditAssets(src, htmlPath) {
  const issues = [];
  const base = dirname(htmlPath);
  const label = basename(htmlPath);
  // 只查 script 與 stylesheet：缺了頁面真的會壞（JS 不執行 / 沒樣式）。
  // <img> 缺檔常是開發中佔位、<link rel=icon/manifest> 缺了不影響運作 → 不硬查，避免雜訊（img 缺 alt 由 auditHtml 守）。
  const refs = [];
  for (const m of src.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of src.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["'][^"']*\bstylesheet\b/i.test(m[0])) continue;
    const href = (m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (href) refs.push(href);
  }
  for (const ref of refs) {
    if (/^(https?:|data:|mailto:|tel:|#|\/\/)/i.test(ref)) continue; // 外部/協定相對/錨點/內嵌：略過
    const clean = ref.replace(/[?#].*$/, '');                        // 去掉 query/hash
    const abs = isAbsolute(clean) ? clean : join(base, clean);
    if (!existsSync(abs)) { issues.push(`引用的本地資產不存在：${ref}`); continue; }
    if (/\.m?js$/i.test(clean)) {
      let js = ''; try { js = readFileSync(abs, 'utf8'); } catch { continue; }
      const bare = bareTemplateTokens(js);
      if (bare.length) issues.push(`引入的腳本 ${ref} 含未替換的裸佔位符 ${bare.slice(0, 4).join('、')}——瀏覽器載入即 ReferenceError`);
    }
  }
  return issues.map((s) => `  [${label}] ${s}`);
}

/**
 * @param {{ cwd?: string }} [opts]
 * @returns {import('../../types.js').DomainPack}
 */
export function createUiuxPack({ cwd = process.cwd() } = {}) {
  const fs = createFsTools(cwd);

  // 淺層走訪 cwd 找 HTML 檔（排除依賴/建置產物目錄），供 verify 做 a11y 守門。
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage']);
  const findHtml = (root, limit = 40) => {
    const found = [];
    const walk = (dir, depth) => {
      if (found.length >= limit || depth > 4) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (found.length >= limit) break;
        if (e.name.startsWith('.') && e.name !== '.') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, depth + 1); }
        else if (/\.html?$/i.test(e.name)) found.push(p);
      }
    };
    walk(root, 0);
    return found;
  };

  return {
    name: 'uiux',
    tools: () => [
      fs.read, fs.ls,
      createGlobTool(cwd), createGrepTool(cwd),     // 探勘既有 UI / design token
      createWebSearchTool(), createWebFetchTool(),  // 參考設計、元件範式、WCAG 準則
      fs.write, fs.edit, fs.bash,                   // 產出前端檔 / 跑 build、格式化、起 dev server
    ],
    systemPrompt: withBaseRules(SYSTEM_PROMPT),
    contextFiles: ['DESIGN.md', 'STYLEGUIDE.md', 'CLAUDE.md', 'AGENTS.md'], // 專案級設計規範注入點
    // mutatingTools 省略 → kernel 從 write/edit/bash 的 metadata 推導
    verify: {
      // 本輪有改動且 cwd 有 HTML 檔才跑；發現 a11y 問題 → 回灌一次讓 agent 修（不無限迴圈）。
      shouldRun: (ctx) => ctx.turnModified && findHtml(ctx.cwd || cwd, 1).length > 0,
      run: async (ctx) => {
        const root = ctx.cwd || cwd;
        const issues = [];
        for (const f of findHtml(root)) {
          let body = '';
          try { body = readFileSync(f, 'utf8'); } catch { continue; }
          issues.push(...auditHtml(body, f.slice(root.length + 1) || f)); // markup a11y
          issues.push(...auditAssets(body, f));                            // 行為：壞引用 / 裸佔位符
          if (issues.length >= 30) break;
        }
        // 專案若自備 a11y 工具（pa11y/axe/lighthouse）→ 跑「真檢查」，把失敗折進回灌（仿 coding 的 detectVerifyCmd）。
        const cmd = detectA11yCmd(root);
        if (cmd) {
          try { execSync(cmd, { cwd: root, stdio: 'pipe', timeout: 60000 }); }
          catch (e) { const out = ((e.stdout?.toString() || '') + (e.stderr?.toString() || '')).trim(); issues.push(`  [專案 a11y 檢查] ${cmd} 未通過：\n${out.slice(-1500) || e.message}`); }
        }
        if (!issues.length) return { ok: true };
        return {
          ok: false,
          output: `可及性與執行期檢查發現問題，請修正：\n${issues.join('\n')}\n（a11y：語意標籤 / img alt / 表單標籤 / 圖示按鈕 aria-label / lang / viewport / 重複id / 正值tabindex / div+onclick。執行期：壞掉的本地資產引用、引入的 JS 含未替換佔位符——抽離 CSS/JS 別把後端要替換的佔位符搬進靜態檔。純裝飾圖片用 alt=""。）`,
        };
      },
      maxRounds: 1,
    },
    preToolPolicy: {
      // read-before-edit：改既有 UI 檔前先讀，避免覆蓋掉既有樣式/結構。
      check: (ctx) => fs.readBeforeEdit(ctx),
    },
    permissionPolicy: { defaultMode: 'default' }, // 寫檔/跑指令預設仍向使用者確認（危險指令一律 gated）
    memoryGuide: '把「使用者的設計偏好、品牌色/字體、慣用框架(Tailwind/CSS/React 等)、元件命名慣例、a11y 要求」存進 memory；把「本專案的 design token、樣式架構、可重用元件清單、佈局慣例」用 playbook 記錄(同 topic 覆蓋)，下次自動載入不必重新摸索。',
  };
}

export const uiuxPack = createUiuxPack();
