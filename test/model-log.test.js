// 模型介面日誌 + 自動重試測試 — 用 fake streamFn 驅動 withLogging，
// 證明每次呼叫寫一行 JSONL 且 outcome 正確分類（ok / empty / interrupted / http-error），
// 金鑰欄位被遮罩，可重試錯誤會重試並各留一行日誌。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelLogger, withLogging, attachLoopLogger } from '../src/kernel/log.js';

const MODEL = { id: 'qwen3.5', api: 'openai-completions', provider: 'internal', baseUrl: 'http://llm.corp/v1' };
const CTX = { systemPrompt: 'sys', messages: [{ role: 'user' }], tools: [{ name: 't' }] };
const textFinal = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }], stopReason: 'stop', usage: { input: 10, output: 5, totalTokens: 15 } });

// 最小 response：async-iterable + result()，模擬 pi-ai 串流物件契約。
function fakeResponse({ events = [], final, iterThrowsAt = -1, resultThrows } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events.length; i++) {
        if (i === iterThrowsAt) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        yield events[i];
      }
    },
    async result() { if (resultThrows) throw resultThrows; return final; },
  };
}

// 驅動一次完整呼叫（迭代事件 → result），把串流錯誤吞掉以便斷言日誌。
async function drive(wrapped, opts = {}) {
  const resp = await wrapped(MODEL, CTX, opts);
  try { for await (const _ of resp) { /* 消費事件 */ } } catch { /* 串流中斷：交給日誌記錄 */ }
  try { return await resp.result(); } catch { return null; }
}

function readLog(dir) {
  return readFileSync(join(dir, 'model-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('正常串流 → outcome=ok，記錄請求/HTTP/usage，金鑰被遮罩', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlog-'));
  try {
    const logger = createModelLogger({ dir, level: 'full' });
    const streamFn = async (model, ctx, opts) => {
      await opts.onPayload?.({ model: model.id, max_tokens: 1024, api_key: 'SEKRIT', messages: ctx.messages }, model);
      await opts.onResponse?.({ status: 200, headers: { authorization: 'Bearer TOP', 'content-type': 'text/event-stream' } }, model);
      return fakeResponse({ events: [{ type: 'text_delta' }, { type: 'done' }], final: textFinal('hi') });
    };
    await drive(withLogging(streamFn, logger, { label: 'main' }));

    const [rec] = readLog(dir);
    assert.equal(rec.outcome, 'ok');
    assert.equal(rec.label, 'main');
    assert.equal(rec.model.id, 'qwen3.5');
    assert.equal(rec.request.messages, 1);
    assert.equal(rec.http.status, 200);
    assert.equal(rec.result.usage.totalTokens, 15);
    assert.equal(typeof rec.timing.firstTokenMs, 'number'); // text_delta → 首字延遲有值
    // 遮罩：body 的 api_key、headers 的 authorization → ***；正常欄位保留
    assert.equal(rec.request.body.api_key, '***');
    assert.equal(rec.request.body.max_tokens, 1024);
    assert.equal(rec.http.headers.authorization, '***');
    assert.equal(rec.http.headers['content-type'], 'text/event-stream');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('串流結束但內容為空 → outcome=empty（「沒回覆就中斷」核心徵狀）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlog-'));
  try {
    const logger = createModelLogger({ dir, level: 'full' });
    const streamFn = async () => fakeResponse({ events: [{ type: 'done' }], final: { role: 'assistant', content: [], stopReason: 'stop' } });
    await drive(withLogging(streamFn, logger));
    assert.equal(readLog(dir)[0].outcome, 'empty');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('串流途中連線斷 → outcome=interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlog-'));
  try {
    const logger = createModelLogger({ dir, level: 'full' });
    const streamFn = async () => fakeResponse({ events: [{ type: 'text_delta' }, { type: 'text_delta' }], iterThrowsAt: 1 });
    await drive(withLogging(streamFn, logger));
    const [rec] = readLog(dir);
    assert.equal(rec.outcome, 'interrupted');
    assert.match(rec.error.message, /socket hang up/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('模型端回 5xx → outcome=http-error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlog-'));
  try {
    const logger = createModelLogger({ dir, level: 'full' });
    const streamFn = async (model, ctx, opts) => {
      await opts.onResponse?.({ status: 503, headers: {} }, model);
      return fakeResponse({ events: [{ type: 'done' }], final: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'upstream down' } });
    };
    await drive(withLogging(streamFn, logger));
    const [rec] = readLog(dir);
    assert.equal(rec.outcome, 'http-error');
    assert.equal(rec.http.status, 503);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('可重試錯誤（ECONNREFUSED）→ 自動重試，兩次各留一行日誌，最終成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlog-'));
  try {
    const logger = createModelLogger({ dir, level: 'brief' });
    let n = 0;
    const streamFn = async () => {
      if (n++ === 0) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return fakeResponse({ events: [{ type: 'done' }], final: textFinal('recovered') });
    };
    const out = await drive(withLogging(streamFn, logger, { maxRetries: 1, backoffMs: 1 }));
    assert.equal(out.content[0].text, 'recovered');
    const recs = readLog(dir);
    assert.equal(recs.length, 2);
    assert.equal(recs[0].attempt, 1);
    assert.equal(recs[1].attempt, 2);
    assert.equal(recs[1].outcome, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 最小 agent stub：只需 subscribe(listener) → 回 unsubscribe，並可手動 emit 事件。
function fakeAgent() {
  const ls = new Set();
  return { subscribe(l) { ls.add(l); return () => ls.delete(l); }, emit(e) { for (const l of ls) l(e); } };
}

test('attachLoopLogger：工具/守衛攔截/回合收尾寫進 agent-loop.jsonl（含 turnId 關聯）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlog-'));
  try {
    const logger = createModelLogger({ dir, level: 'full' });
    const agent = fakeAgent();
    attachLoopLogger(agent, logger, { turnId: 't1' });

    // 一次正常工具
    agent.emit({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'write' });
    agent.emit({ type: 'tool_execution_end', toolCallId: 'a', toolName: 'write', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    // 一次被守衛擋掉（isError=true + 理由）
    agent.emit({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'edit' });
    agent.emit({ type: 'tool_execution_end', toolCallId: 'b', toolName: 'edit', isError: true, result: { content: [{ type: 'text', text: 'read-before-edit 擋下' }] } });
    // 回合以 error 收尾（handleRunFailure 情境）
    agent.emit({ type: 'turn_end', message: { stopReason: 'error', errorMessage: '模型端空回應' }, toolResults: [] });
    agent.emit({ type: 'agent_end', messages: [{}, {}] });

    const recs = readFileSync(join(dir, 'agent-loop.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recs.length, 4);
    assert.ok(recs.every((r) => r.turnId === 't1'));
    assert.deepEqual(recs.map((r) => r.kind), ['tool', 'tool', 'turn_end', 'agent_end']);
    const blocked = recs.find((r) => r.tool === 'edit');
    assert.equal(blocked.isError, true);
    assert.match(blocked.error, /read-before-edit/);
    const turnEnd = recs.find((r) => r.kind === 'turn_end');
    assert.equal(turnEnd.stopReason, 'error');
    assert.equal(turnEnd.errorMessage, '模型端空回應');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('level=off → 不寫任何日誌、零開銷', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlog-'));
  try {
    const logger = createModelLogger({ dir, level: 'off' });
    const streamFn = async () => fakeResponse({ events: [{ type: 'done' }], final: textFinal('x') });
    await drive(withLogging(streamFn, logger));
    assert.throws(() => readFileSync(join(dir, 'model-calls.jsonl'), 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
