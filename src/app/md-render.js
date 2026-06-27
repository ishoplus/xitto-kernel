// Markdown → 終端 ANSI 渲染（對標 Claude Code 的回覆排版）
// 用 marked 解析、marked-terminal 轉 ANSI（標題、粗體、列表、表格、程式碼區塊語法高亮）。
// Claude Code 的做法：每來一個 token 就把「目前累積的整段 markdown」重新解析重繪，
// 半截的 **粗體 / 未閉合的 ``` 會在下一幀補齊後自動修正。本檔提供純函式 md()，
// 重繪由 Ink 的 re-render 負責（見 tui.js）。
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { highlight as hl } from 'cli-highlight';

// 終端寬度（隨視窗；最小 40 避免表格擠壞）
function termWidth() {
  const w = process.stdout?.columns || 80;
  return Math.max(40, Math.min(w, 120));
}

// ANSI 樣式小工具（marked-terminal 的樣式選項接受 (str)=>str 函式）
const a = (open, close) => (s) => `\x1b[${open}m${s}\x1b[${close}m`;
const bold = a(1, 22);
const cyan = a(36, 39);
const yellow = a(33, 39);
const gray = a(90, 39);

// 程式碼區塊本體：語法高亮 + 左側豎線邊框（+ 可選語言標籤）。不含前後空行，方便外部逐塊拼接。
// withHeader=false 用於「同一個 code block 的延續塊」（串流逐行提交時避免重複 ┌─ lang 標頭）。
export function codeChunk(text, lang, withHeader = true) {
  let body;
  try { body = hl(text, { language: lang || 'plaintext', ignoreIllegals: true }); }
  catch { body = text; }
  const bar = gray('│') + ' ';
  const label = (withHeader && lang) ? gray(`┌─ ${lang}`) + '\n' : '';
  return label + body.replace(/\n$/, '').split('\n').map((l) => bar + l).join('\n');
}

// 程式碼區塊（marked renderer 用）：前後補空行與內文隔開
function codeBlock(text, lang) {
  return '\n' + codeChunk(text, lang, true) + '\n';
}

// 依寬度快取 Marked 實例：終端 resize 後寬度改變 → 換一個實例，markdown 自動以新寬度重排。
// 上限保護：resize 反覆拖動會堆積不同寬度的實例，超過上限即淘汰最舊的(LRU 近似)。
const cache = new Map();
const MAX_CACHE = 32;
function renderer(width) {
  let m = cache.get(width);
  if (!m) {
    m = new Marked();
    m.use(
      markedTerminal({
        width,
        reflowText: true,
        tab: 2,
        showSectionPrefix: false,          // 不顯示標題的 # 記號（對標 Claude Code）
        firstHeading: (s) => bold(cyan(s)), // 一級標題：粗體青
        heading: (s) => bold(s),            // 其餘標題：粗體
        strong: (s) => bold(s),
        codespan: (s) => yellow(s),
        blockquote: (s) => gray(s),
        listitem: (s) => s,
      }),
    );
    // 覆寫 code 渲染：加左側邊框（marked-terminal 內建無邊框）
    m.use({
      renderer: {
        code(token, infostring) {
          const text = typeof token === 'object' ? token.text : token;
          const lang = (typeof token === 'object' ? token.lang : infostring) || '';
          return codeBlock(text, lang);
        },
      },
    });
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value); // 淘汰最舊
    cache.set(width, m);
  }
  return m;
}

// 用 marked 的 block lexer 把 markdown 切成頂層區塊 token（含 .raw，串接即原文）。
// 串流增量提交用：提交「除最後一塊外」的完整區塊，最後一塊（可能還沒打完）留在動態區。
const lexMarked = new Marked();
export function lexBlocks(text) {
  try { return lexMarked.lexer(text); }
  catch { return [{ type: 'paragraph', raw: text }]; }
}

// 把 markdown 字串渲染成帶 ANSI 的終端字串。容錯：解析失敗就回原文。
export function md(text) {
  if (!text) return '';
  try {
    const out = renderer(termWidth()).parse(text);
    // 無序列表符號 * → •（marked-terminal 的 BULLET_POINT 寫死為 '* '）
    return (typeof out === 'string' ? out : String(out)).replace(/\n+$/, '').replace(/^(\s*)\* /gm, '$1• ');
  } catch {
    return text;
  }
}
