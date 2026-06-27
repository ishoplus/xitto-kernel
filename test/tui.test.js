// Ink TUI 煙霧測試 — 渲染不崩潰、store 邏輯、狀態列。（互動輸入需真實終端，這裡只驗渲染。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { createStore, App, gutter, backspaceAt } from '../src/app/tui.js';

const noopHandlers = { onSubmit() {}, onCtrlC() {}, onEscape() {}, getHistory: () => [], complete: () => null, onSelectChoice() {}, onSelectCancel() {}, onSelectAbort() {} };

test('App 渲染不崩潰 + 顯示 transcript 與狀態列', () => {
  const store = createStore();
  store.set({ modelLabel: 'MiniMax-M2.7', cwdLabel: '~/proj', sandboxLabel: '🔒 sandbox' });
  store.pushBlock('hello-transcript-block');
  const { lastFrame, unmount } = render(React.createElement(App, { store, handlers: noopHandlers }));
  const f = lastFrame();
  assert.match(f, /hello-transcript-block/);
  assert.match(f, /MiniMax-M2\.7/);
  assert.match(f, /sandbox/);
  unmount();
});

test('store：appendLive → finalizeLive 提交區塊進 transcript', () => {
  const store = createStore();
  store.appendLive('第一段。\n\n第二段。');
  store.finalizeLive();
  const items = store.get().transcript;
  assert.ok(items.length >= 1);
  assert.match(items.map((i) => i.text).join('\n'), /第一段|第二段/);
});

test('store：權限 Select 模式切換', () => {
  const store = createStore();
  store.askSelect('允許 write?', ['允許', '拒絕']);
  assert.equal(store.get().mode, 'select');
  assert.ok(store.get().selection);
  store.clearSelect();
  assert.equal(store.get().selection, null);
});

test('gutter / backspaceAt 純函數', () => {
  assert.match(gutter('a\nb', '\x1b[32m⏺\x1b[39m'), /a\n {2}b/);
  assert.deepEqual(backspaceAt('abc', 2), { value: 'ac', cursor: 1 });
});
