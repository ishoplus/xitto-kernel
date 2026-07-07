// Web 共用 markdown 渲染器（src/app/web/shared/md.js）— 對話/檔案預覽的 HTML 輸出。
// 該檔是掛 window.mdRender 的 IIFE；此處以 Function 注入假 window 取出 mdRender 測其輸出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/app/web/shared/md.js'), 'utf8');
const win = {};
new Function('window', src)(win);
const md = win.mdRender;

test('強調：**粗** / __粗__ / *斜* / _斜_ 皆渲染', () => {
  assert.match(md('**a**'), /<strong>a<\/strong>/);
  assert.match(md('__b__'), /<strong>b<\/strong>/);
  assert.match(md('*c*'), /<em>c<\/em>/);
  assert.match(md('這是 _d_ 字'), /<em>d<\/em>/);
});

test('底線變體限詞邊界：snake_case 不被斜體（a_b_c、file_name_here）', () => {
  assert.equal(md('file_name_here'), '<p>file_name_here</p>');
  assert.equal(md('my_var_name 保持'), '<p>my_var_name 保持</p>');
  assert.doesNotMatch(md('a_b_c'), /<em>/);
});

test('code / URL 內的底線不被強調誤傷', () => {
  assert.match(md('用 `get_user_name()`'), /<code>get_user_name\(\)<\/code>/);
  assert.doesNotMatch(md('用 `get_user_name()`'), /<em>/);
  assert.match(md('見 https://x.com/a_b_c 連結'), /https:\/\/x\.com\/a_b_c/);
  assert.doesNotMatch(md('見 https://x.com/a_b_c 連結'), /<em>/);
});

test('佔位符哨兵不與內文數字撞位（"step 3 done" 原樣）', () => {
  assert.equal(md('step 3 done and 12 items'), '<p>step 3 done and 12 items</p>');
});

test('連結：https 連結可點 + 顯示文字內的強調照樣渲染', () => {
  const out = md('[看 **報告**](https://x.com/r_v_1)');
  assert.match(out, /<a href="https:\/\/x\.com\/r_v_1"[^>]*>看 <strong>報告<\/strong><\/a>/);
});

test('有序清單保留起始號：3. → <ol start="3">', () => {
  assert.match(md('3. 甲\n4. 乙'), /<ol start="3"><li>甲<\/li><li>乙<\/li><\/ol>/);
  assert.match(md('1. 甲\n2. 乙'), /^<ol><li>/); // 從 1 開始 → 不加 start
});

test('既有能力不回歸：標題 / 表格 / 程式碼塊 / 待辦清單 / 行內碼', () => {
  assert.match(md('# 標題'), /<h1>標題<\/h1>/);
  assert.match(md('| A | B |\n| - | - |\n| 1 | 2 |'), /<table class='md-table'>.*<th>A<\/th>.*<td>1<\/td>/s);
  // 程式碼塊：語法高亮後 token 帶 span，但仍是 pre.code + lang class（高亮細節見 web-md-highlight.test.js）
  assert.match(md('```js\nconst x=1;\n```'), /<pre class='code'><code class="lang-js">.*const.*<\/code><\/pre>/s);
  assert.match(md('- [x] 完成'), /☑ 完成/);
  assert.match(md('這是 `code`'), /<code>code<\/code>/);
});

test('轉義防 XSS：HTML 標記被轉義', () => {
  assert.match(md('<script>alert(1)</script>'), /&lt;script&gt;/);
  assert.doesNotMatch(md('<img src=x onerror=y>'), /<img src=x/);
});
