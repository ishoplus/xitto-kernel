// 輕量串流 markdown 渲染器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamRenderer } from '../src/app/markdown.js';

const collect = () => { const out = []; return { out: (s) => out.push(s), text: () => out.join('') }; };

test('inline：粗體 + inline code 套 ANSI', () => {
  const c = collect();
  const md = createStreamRenderer(c.out);
  md.push('這是 **粗體** 和 `code`\n');
  const t = c.text();
  assert.match(t, /\x1b\[1m粗體\x1b\[0m/);   // bold
  assert.match(t, /\x1b\[36mcode\x1b\[0m/);  // cyan inline code
});

test('標題：# 去掉井號、套粗體', () => {
  const c = collect();
  const md = createStreamRenderer(c.out);
  md.push('# 標題\n');
  const t = c.text();
  assert.match(t, /\x1b\[1m標題\x1b\[0m/);
  assert.doesNotMatch(t, /#/);
});

test('code block：``` 內的行套 code 色、不套 inline', () => {
  const c = collect();
  const md = createStreamRenderer(c.out);
  md.push('```js\nconst x = `tpl`;\n```\n');
  const t = c.text();
  assert.match(t, /\x1b\[36mconst x = `tpl`;/);  // 整行 code 色，inline 不再處理
});

test('flush：輸出末尾未換行的殘行', () => {
  const c = collect();
  const md = createStreamRenderer(c.out);
  md.push('沒有換行的最後一行');
  assert.equal(c.text(), '');     // 還沒輸出
  md.flush();
  assert.match(c.text(), /沒有換行的最後一行/);
});

test('first line 有 ● 前綴，後續行無', () => {
  const c = collect();
  const md = createStreamRenderer(c.out);
  md.push('第一行\n第二行\n');
  const lines = c.text().split('\n');
  assert.match(lines[0], /● /);
  assert.doesNotMatch(lines[1], /●/);
});
