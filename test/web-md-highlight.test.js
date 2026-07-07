// 網頁 mdRender 的輕量語法高亮（shared/md.js）— token 上色 + XSS 安全。
// md.js 是瀏覽器 IIFE（掛 window.mdRender），用 vm 注入假 window 後取用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../src/app/web/shared/md.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const md = sandbox.window.mdRender;
const block = (lang, body) => md('```' + lang + '\n' + body + '\n```');

test('js：關鍵字/字串/註解/數字各自上色', () => {
  const h = block('js', 'const x = "hi"; // note\nreturn 42');
  assert.match(h, /<span class="hl-key">const<\/span>/);
  assert.match(h, /<span class="hl-str">&quot;hi&quot;<\/span>/);
  assert.match(h, /<span class="hl-com">\/\/ note<\/span>/);
  assert.match(h, /<span class="hl-num">42<\/span>/);
});

test('json：鍵=prop、字串=str、數字=num、字面值=lit', () => {
  const h = block('json', '{"name": "q", "n": 3.5, "ok": true, "x": null}');
  assert.match(h, /<span class="hl-prop">&quot;name&quot;<\/span>/);
  assert.match(h, /<span class="hl-str">&quot;q&quot;<\/span>/);
  assert.match(h, /<span class="hl-num">3\.5<\/span>/);
  assert.match(h, /<span class="hl-lit">true<\/span>/);
  assert.match(h, /<span class="hl-lit">null<\/span>/);
});

test('py / sql：關鍵字上色（sql 大小寫不敏感）', () => {
  assert.match(block('py', 'def f(x):\n    return x  # c'), /<span class="hl-key">def<\/span>/);
  assert.match(block('py', 'def f(x):\n    return x  # c'), /<span class="hl-com"># c<\/span>/);
  const s = block('sql', 'SELECT id FROM t WHERE a > 1');
  assert.match(s, /<span class="hl-key">SELECT<\/span>/);
  assert.match(s, /<span class="hl-key">FROM<\/span>/);
});

test('XSS 安全：程式碼內的 HTML 一律轉義，不逸出成標籤', () => {
  const h = block('js', 'var s = "</script><b>x</b>";');
  assert.ok(!/<b>x<\/b>/.test(h), '不得出現原始 <b> 標籤');
  assert.ok(!/<\/script>/.test(h), '不得出現原始 </script>');
  assert.match(h, /&lt;\/script&gt;&lt;b&gt;/, '應被轉義');
});

test('未知語言：不加 hl span，但仍轉義（維持現況、不破格）', () => {
  const h = block('foo', 'hello <x> & "y"');
  assert.ok(!/hl-/.test(h), '未知語言不應有 hl 類別');
  assert.match(h, /hello &lt;x&gt; &amp; &quot;y&quot;/);
});

test('非程式碼 markdown 不受影響（回歸）', () => {
  assert.match(md('# 標題'), /<h1>標題<\/h1>/);
  assert.match(md('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(md('行內 `code` 保持不變'), /<code>code<\/code>/);
});
