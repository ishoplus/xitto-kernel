// uiux pack 注入 frontend-design（CC）的設計方向指南 —— 有主張、避免套版、signature 元素。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUiuxPack } from '../src/packs/uiux/index.js';

test('uiux pack systemPrompt 含 frontend-design 精華（設計方向/signature/避套版）', () => {
  const p = createUiuxPack({ cwd: '/tmp' });
  const s = p.systemPrompt;
  assert.equal(typeof s, 'string');
  assert.match(s, /設計方向/);
  assert.match(s, /Hero 是論點/);
  assert.match(s, /signature 元素/);
  assert.match(s, /cliché/);
  assert.match(s, /兩段式流程/);
  // dataviz 指南（CC dataviz 移植）：調色板/色盲/選型
  assert.match(s, /資料視覺化/);
  assert.match(s, /三種調色板/);
  assert.match(s, /色盲/);
  assert.match(s, /圖表選型/);
  // 既有 a11y 底線仍在（沒被覆蓋）
  assert.match(s, /WCAG 2\.2 AA/);
  // 共用輸出規範仍注入（withBaseRules）
  assert.match(s, /輸出避免使用 emoji/);
});
