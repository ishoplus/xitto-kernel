// Ink TUI 煙霧測試 — 渲染不崩潰、store 邏輯、狀態列。（互動輸入需真實終端，這裡只驗渲染。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { createStore, App, gutter, backspaceAt } from '../src/app/tui.js';
import { summarize, toolBlock, previewChange, toolDigest, toolResultBlock, toolLabel, slashComplete } from '../src/app/tui-run.js';
const strip = (s) => s.replace(/\x1b\[[0-9]+m/g, '');

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

test('狀態列 verb：輸出中不因區塊提交瞬間閃回思考中（outputting 旗標）', () => {
  // appendLive 開始吐字 → outputting 旗標亮；finalizeLive 後熄
  const s = createStore();
  s.appendLive('一段內容');
  assert.equal(s.get().outputting, true, '吐字時 outputting=true');
  s.finalizeLive();
  assert.equal(s.get().outputting, false, 'finalize 後 outputting=false');

  // live 已空但 outputting 仍亮（區塊剛提交的瞬間）→ 狀態列仍「輸出中」，不閃回思考中
  const busy = createStore({ mode: 'busy', busyAt: Date.now() - 3000, live: '', outputting: true });
  const r1 = render(React.createElement(App, { store: busy, handlers: noopHandlers }));
  assert.match(r1.lastFrame(), /輸出中/);
  assert.doesNotMatch(r1.lastFrame(), /思考中/);
  r1.unmount();

  // 工具執行中 → 優先「執行中」（即使 outputting 殘留）
  const tooling = createStore({ mode: 'busy', busyAt: Date.now() - 1000, outputting: true });
  tooling.setTool({ name: 'bash', summary: 'ls' });
  const r2 = render(React.createElement(App, { store: tooling, handlers: noopHandlers }));
  assert.match(r2.lastFrame(), /執行中/);
  r2.unmount();

  // 純思考（無 live 無 outputting 無 tool）→ 思考中
  const thinking = createStore({ mode: 'busy', busyAt: Date.now() - 2000 });
  const r3 = render(React.createElement(App, { store: thinking, handlers: noopHandlers }));
  assert.match(r3.lastFrame(), /思考中/);
  r3.unmount();
});

test('store：權限 Select 模式切換', () => {
  const store = createStore();
  store.askSelect('允許 write?', ['允許', '拒絕']);
  assert.equal(store.get().mode, 'select');
  assert.ok(store.get().selection);
  store.clearSelect();
  assert.equal(store.get().selection, null);
});

test('summarize：取有意義的參數而非全 JSON（像 Claude Code）', () => {
  assert.equal(summarize({ command: 'npm test' }), 'npm test');
  assert.equal(summarize({ path: 'src/a.js', content: '...' }), 'src/a.js');
  assert.equal(summarize({}), '');
  assert.equal(summarize(null), '');
});

test('toolBlock：⏺ 標頭(args) + ⎿ 多行 + 摺疊 +N 行 + 耗時', () => {
  const r = { content: [{ type: 'text', text: Array.from({ length: 14 }, (_, i) => 'L' + i).join('\n') }] };
  const out = strip(toolBlock('bash', 'npm test', r, false, '1.2s'));
  assert.match(out, /⏺ bash\(npm test\) 1\.2s/); // 耗時附標頭
  assert.match(out, /⎿ L0/);
  assert.match(out, /L9/);            // 顯示前 10 行
  assert.doesNotMatch(out, /L10\b/);  // 第 11 行起摺疊
  assert.match(out, /… \+4 行/);      // 14 - 10 = 4
  // 空結果 → ✓ / ✗ 標記
  assert.match(strip(toolBlock('x', '', { content: [] }, false)), /⎿ ✓/);
  assert.match(strip(toolBlock('x', '', { content: [] }, true)), /⎿ ✗/);
});

test('slashComplete：斜線指令三層聯動（指令→參數→子項）', () => {
  const slashMap = { '/help': '說明', '/model': '切換模型', '/skills': '技能' };
  const hasArgs = new Set(['/model', '/skills']);
  const argsFor = (cmd) => cmd === '/model' ? [{ value: 'm1', desc: 'p' }, { value: 'm2', desc: 'q' }]
    : cmd === '/skills' ? [{ value: 'check' }, { value: 'forget ', sub: () => [{ value: 'alpha' }, { value: 'beta' }] }]
      : null;
  const sc = (t) => slashComplete(t, { slashMap, hasArgs, argsFor });
  // L1：/ → 全部指令，有參數者 value 尾隨空白（接受後聯動下一層）
  assert.deepEqual(sc('/').items.map((i) => i.value), ['/help', '/model ', '/skills ']);
  assert.deepEqual(sc('/mo').items.map((i) => i.value), ['/model ']); // 前綴過濾
  // L2：/model → 模型清單；過濾
  assert.deepEqual(sc('/model ').items.map((i) => i.value), ['m1', 'm2']);
  assert.deepEqual(sc('/model m2').items.map((i) => i.value), ['m2']);
  assert.equal(sc('/model m').start, '/model '.length); // start 落在參數起點
  // L2：/skills → check/forget（forget 尾隨空白→聯動 L3）
  assert.deepEqual(sc('/skills ').items.map((i) => i.value), ['check', 'forget ']);
  // L3：/skills forget → 子項清單；過濾；start 正確
  assert.deepEqual(sc('/skills forget ').items.map((i) => i.value), ['alpha', 'beta']);
  assert.deepEqual(sc('/skills forget be').items.map((i) => i.value), ['beta']);
  assert.equal(sc('/skills forget be').start, '/skills forget '.length);
  // 無參數指令的 L2、非聯動子項的 L3 → null
  assert.equal(sc('/help '), null);
  assert.equal(sc('/skills check x'), null); // check 無 sub
});

test('toolLabel：友善工具名（對標 CC 的 ⏺ Read）', () => {
  assert.equal(toolLabel('read'), '讀檔');
  assert.equal(toolLabel('grep'), '搜尋');
  assert.equal(toolLabel('unknown_tool'), 'unknown_tool'); // 未列出用原名
});

test('toolDigest：讀類工具只摘要一行、不灌內容（對標 CC）', () => {
  // read：附行號內容 → 只顯示「讀取 N 行」，不含內容本身
  const readRes = { content: [{ type: 'text', text: '     1\texport const X = 1;\n     2\tfunction foo() {}' }] };
  assert.equal(toolDigest('read', readRes), '讀取 2 行');
  // read 超出 → 附「+N 未顯示」
  const readMore = { content: [{ type: 'text', text: '     1\ta\n     2\tb\n… 還有 98 行（用 offset=3 繼續）' }] };
  assert.equal(toolDigest('read', readMore), '讀取 2 行（+98 未顯示）');
  // glob：JSON → N 個檔案
  assert.equal(toolDigest('glob', { content: [{ type: 'text', text: '{"pattern":"**/*.js","count":7,"files":[]}' }] }), '7 個檔案');
  // ls：清單 → N 項
  assert.equal(toolDigest('ls', { content: [{ type: 'text', text: 'a.js\nb/\nc.md' }] }), '3 項');
  // bash / 錯誤 JSON → null（交給 toolBlock 顯示完整結果）
  assert.equal(toolDigest('bash', { content: [{ type: 'text', text: 'some output' }] }), null);
  assert.equal(toolDigest('read', { content: [{ type: 'text', text: '{"error":"檔案不存在"}' }] }), null);
});

test('toolResultBlock：read 走摘要一行、bash 走完整 toolBlock', () => {
  const readRes = { content: [{ type: 'text', text: '     1\ta\n     2\tb\n     3\tc' }] };
  const rb = strip(toolResultBlock('read', 'src/a.js', readRes, false, '0.1s'));
  assert.match(rb, /⏺ 讀檔\(src\/a\.js\) 0\.1s/); // 友善名 + 摘要
  assert.match(rb, /⎿ 讀取 3 行/);
  assert.doesNotMatch(rb, /export|function/);      // 不把檔案內容灌進轉錄
  // bash：無 digest → 走 toolBlock 顯示完整輸出
  const bashRes = { content: [{ type: 'text', text: 'line1\nline2' }] };
  const bb = strip(toolResultBlock('bash', 'ls', bashRes, false));
  assert.match(bb, /⏺ bash\(ls\)/);
  assert.match(bb, /line1/);
  assert.match(bb, /line2/);
});

test('previewChange：核准前顯示 write/edit 要改什麼（不再盲核准）', () => {
  // write：路徑 + 行數 + 綠色新增行
  const w = strip(previewChange('write', { path: 'a.txt', content: 'x\ny\nz' }));
  assert.match(w, /寫入 a\.txt \(3 行\)/);
  assert.match(w, /\+ x/);
  assert.match(w, /\+ z/);
  // write：超過 12 行 → 折疊
  const big = strip(previewChange('write', { path: 'b', content: Array.from({ length: 20 }, (_, i) => 'L' + i).join('\n') }));
  assert.match(big, /… \+8 行/); // 20 - 12
  // edit：紅 - 舊 / 綠 + 新
  const e = strip(previewChange('edit', { path: 'c.js', oldText: 'old', newText: 'new' }));
  assert.match(e, /編輯 c\.js/);
  assert.match(e, /- old/);
  assert.match(e, /\+ new/);
  // 非 write/edit 或無 path → 空字串（不干擾一般工具的權限提示）
  assert.equal(previewChange('bash', { command: 'ls' }), '');
  assert.equal(previewChange('write', {}), '');
});

test('fmtTok：token 壓縮顯示', async () => {
  const { fmtTok } = await import('../src/app/tui-run.js');
  assert.equal(fmtTok(42), '42');
  assert.equal(fmtTok(1200), '1.2k');
  assert.equal(fmtTok(12000), '12k');
});

test('gutter / backspaceAt 純函數', () => {
  assert.match(gutter('a\nb', '\x1b[32m⏺\x1b[39m'), /a\n {2}b/);
  assert.deepEqual(backspaceAt('abc', 2), { value: 'ac', cursor: 1 });
});
