// 前景串流的「每對話一個 run」隔離保證：A 串流中切到 B，A 的回覆
// (1) 繼續進 A 自己的陣列、(2) 不污染 B、(3) 不重繪 B；切回 A → 重接同一陣列並續播。
//
// 作法：直接從 chat.html 抽出「真實」的 handleEvent / onRunEvent 原始碼（不重寫，
// 跟著檔案走，日後誰改壞 `run.chatMsgs === messages` 閘門就會被這裡擋下），
// 注入最小 stub 後驅動事件、斷言副作用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { turnNotice } from '../src/kernel/index.js';

const html = readFileSync(new URL('../src/app/web/chat.html', import.meta.url), 'utf8');

// 以大括號配對抽出具名函式原始碼（這兩個函式內字串/註解不含大括號，naive 計數即可）。
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `找不到 function ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name} 大括號不平衡`);
}

// 建立測試沙箱：放入真實的兩個函式 + 最小 stub，回傳操作介面。
function makeHarness() {
  const factory = new Function(`
    ${extractFn(html, 'handleEvent')}
    ${extractFn(html, 'onRunEvent')}
    ${extractFn(html, 'ensureReply')}
    let messages = null, sessionId = null, composing = false;
    let renders = 0, statusUpdates = 0, renderChatsCount = 0;
    const upserts = [];
    function render() { renders++; }
    function scrollDown() {}
    function updateStreamStatus() { statusUpdates++; }
    function renderChats() { renderChatsCount++; }
    function upsertChat(c) { upserts.push(c); }
    function refreshCtxMeter() {} // 上下文佔用指示器（真實 onRunEvent 會於 session/usage/compact 呼叫）
    return {
      onRunEvent, handleEvent, ensureReply,
      setMessages: (m) => { messages = m; },
      getSessionId: () => sessionId,
      setSessionId: (s) => { sessionId = s; },
      renders: () => renders,
      statusUpdates: () => statusUpdates,
      renderChatsCount: () => renderChatsCount,
      upserts: () => upserts,
      reset: () => { renders = 0; statusUpdates = 0; renderChatsCount = 0; },
    };
  `);
  return factory();
}

const mkArr = (u) => {
  const asst = { role: 'assistant', text: '', tools: [], phase: 'thinking' };
  return [{ role: 'user', text: u }, asst];
};

test('handleEvent 只 mutate 傳入的 asst，兩個對話各自累積、互不干擾', () => {
  const h = makeHarness();
  const a = mkArr('A?')[1];
  const b = mkArr('B?')[1];
  h.handleEvent({ type: 'text', delta: 'A-hello' }, a);
  assert.equal(a.text, 'A-hello');
  assert.equal(b.text, '', 'B 的 asst 完全沒被碰');
  h.handleEvent({ type: 'text', delta: 'B-hi' }, b);
  assert.equal(a.text, 'A-hello', 'A 不受 B 事件影響');
  assert.equal(b.text, 'B-hi');
  h.handleEvent({ type: 'tool', name: 'read_file', args: {} }, a);
  assert.equal(a.tools.length, 1);
  assert.equal(b.tools.length, 0, 'B 的工具列沒被 A 污染');
});

test('A 串流中、使用者在看 B：A 事件進 A 陣列、不污染 B、不重繪 B', () => {
  const h = makeHarness();
  const arrA = mkArr('問 A');
  const arrB = mkArr('問 B');
  const runA = { chatMsgs: arrA, asst: arrA[1], sessionId: 'A', tokens: 0 };

  h.setMessages(arrB);          // 使用者正在看 B
  h.setSessionId('B');          // 全域 sessionId 指向 B
  h.reset();

  h.onRunEvent(runA, { type: 'text', delta: '一段回覆' });
  h.onRunEvent(runA, { type: 'usage', input: 10, output: 5 });

  assert.equal(arrA[1].text, '一段回覆', 'A 的回覆持續進 A 自己的陣列');
  assert.equal(runA.tokens, 15, 'token 累在 run 上');
  assert.equal(arrB[1].text, '', 'B 的陣列完全沒被 A 污染');
  assert.equal(h.renders(), 0, '看 B 時 A 的事件不觸發重繪');
  assert.equal(h.statusUpdates(), 0, '看 B 時 A 的事件不更新狀態列');

  // A 的 done 到達，但使用者仍在看 B → 不可覆寫全域 sessionId
  h.onRunEvent(runA, { type: 'done', sessionId: 'A' });
  assert.equal(h.getSessionId(), 'B', 'A 的 done 不搶走全域 sessionId');
  assert.equal(runA.sessionId, 'A');
});

test('切回 A：重接同一陣列 → 後續事件恢復即時重繪、續播', () => {
  const h = makeHarness();
  const arrA = mkArr('問 A');
  const runA = { chatMsgs: arrA, asst: arrA[1], sessionId: 'A', tokens: 0 };

  // 先在看別的對話時累積一段（不重繪）
  h.setMessages(mkArr('別的'));
  h.onRunEvent(runA, { type: 'text', delta: '前半' });
  assert.equal(arrA[1].text, '前半');

  // openChat(A) 的效果：messages 重接回 runA.chatMsgs（同一個陣列參照）
  h.setMessages(runA.chatMsgs);
  h.reset();
  h.onRunEvent(runA, { type: 'text', delta: '後半' });

  assert.equal(arrA[1].text, '前半後半', '看得到切走期間累積的內容 + 續播');
  assert.equal(h.renders(), 1, '切回 A 後，A 的事件恢復即時重繪');
  assert.equal(h.statusUpdates(), 1);
});

test('全新對話：串流首個 session 事件 → 立刻登進側欄、同步全域 sessionId（可切回）', () => {
  const h = makeHarness();
  const arrN = mkArr('全新問題');
  const runN = { chatMsgs: arrN, asst: arrN[1], sessionId: null, tokens: 0, firstUserText: '全新問題', space: 'default', pack: 'general' };

  h.setMessages(arrN);          // 正在看這個新對話
  h.onRunEvent(runN, { type: 'session', sessionId: 'sess-1' });

  assert.equal(runN.sessionId, 'sess-1', 'run 拿到 sessionId');
  assert.equal(h.getSessionId(), 'sess-1', '看著它 → 全域同步');
  assert.equal(h.upserts().length, 1, '新對話即時登進側欄');
  assert.equal(h.upserts()[0].id, 'sess-1');
  assert.equal(arrN[1].text, '', 'session 事件不當作內容寫入');

  // 重複 session 事件（或稍後的）不再重登、不覆寫
  h.onRunEvent(runN, { type: 'session', sessionId: '不該覆寫' });
  assert.equal(runN.sessionId, 'sess-1');
  assert.equal(h.upserts().length, 1, '不重複登記');
});

// ── 保底：每輪都要有可見結果（正常/截斷/中斷/空/連線中斷），絕不靜默 ──
const mkRun = (over = {}) => ({ asst: { text: '', tools: [] }, gotDone: true, ...over });

test('ensureReply：正常有內容 → 不加提示', () => {
  const h = makeHarness();
  const run = mkRun({ asst: { text: '完整回覆', tools: [] }, stopReason: 'stop' });
  h.ensureReply(run);
  assert.equal(run.asst.note, undefined);
});

test('ensureReply：length 截斷 → 提示可調 maxTokens（即使有半截文字）', () => {
  const h = makeHarness();
  const run = mkRun({ asst: { text: '講到一半', tools: [], stopReason: 'length' } });
  run.asst.stopReason = 'length';
  h.ensureReply(run);
  assert.match(run.asst.note, /截斷|maxTokens/);
});

test('ensureReply：使用者按停止 → 提示「已中斷」', () => {
  const h = makeHarness();
  const run = mkRun({ userStopped: true, asst: { text: '', tools: [] } });
  h.ensureReply(run);
  assert.equal(run.asst.note, '已中斷');
});

test('ensureReply：連線中斷（沒收到 done）且無內容 → 提示重試', () => {
  const h = makeHarness();
  const run = mkRun({ gotDone: false, asst: { text: '', tools: [] } });
  h.ensureReply(run);
  assert.match(run.asst.note, /沒有取得回覆|連線/);
});

test('ensureReply：正常收到 done 但模型空回應 → 提示重試', () => {
  const h = makeHarness();
  const run = mkRun({ asst: { text: '', tools: [] }, stopReason: 'stop' });
  h.ensureReply(run);
  assert.match(run.asst.note, /沒有產生內容|重試/);
});

test('ensureReply：已是 ⚠ 錯誤訊息 → 不再疊提示', () => {
  const h = makeHarness();
  const run = mkRun({ gotDone: false, asst: { text: '⚠ 連線失敗（500）', tools: [] } });
  h.ensureReply(run);
  assert.equal(run.asst.note, undefined, '錯誤訊息本身已可見，不重複');
});

test('ensureReply：有工具活動但無文字（純執行）→ 視為有內容，不提示空', () => {
  const h = makeHarness();
  const run = mkRun({ asst: { text: '', tools: [{ name: 'write_file', done: true }] }, stopReason: 'stop' });
  h.ensureReply(run);
  assert.equal(run.asst.note, undefined);
});

test('kernel turnNotice：五種結局各給一句話（正常→空字串）', () => {
  assert.equal(turnNotice('stop', true), '', '正常有內容 → 無提示');
  assert.match(turnNotice('length', true), /截斷|maxTokens/);
  assert.match(turnNotice('error', true), /錯誤/);
  assert.match(turnNotice('aborted', true), /中斷/);
  assert.match(turnNotice('stop', false), /沒有產生|重試/, '空回應也要有話講');
});
