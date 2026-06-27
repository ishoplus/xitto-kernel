// 事實層自動萃取：解析、extractFacts（去重/失敗容錯）、kernel api.extractMemory、runTurn 自動鉤子。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFacts, extractFacts } from '../src/kernel/extract.js';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'xk-ex-'));
const msgs = (...texts) => texts.map((t, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: t }] }));
// 假 streamFn：回傳固定文字當作 LLM 輸出
const streamReturning = (textOut) => () => ({ async *[Symbol.asyncIterator]() { yield { type: 'done' }; }, result: async () => ({ role: 'assistant', content: [{ type: 'text', text: textOut }] }) });

test('parseFacts：JSON 陣列 / 夾雜文字 / 非陣列 → []', () => {
  assert.deepEqual(parseFacts('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseFacts('好的，這些是：["偏好繁中","用 pnpm"] 以上'), ['偏好繁中', '用 pnpm']);
  assert.deepEqual(parseFacts('沒有 JSON'), []);
  assert.deepEqual(parseFacts('{"a":1}'), []);
  assert.deepEqual(parseFacts(''), []);
});

test('extractFacts：抽出事實 + 過濾已知 + 空對話/失敗容錯', async () => {
  const base = { model: { id: 'x', provider: 'p' }, getApiKey: () => 'k' };
  const facts = await extractFacts({ ...base, streamFn: streamReturning('["使用者偏好繁體中文","專案用 pnpm"]'), messages: msgs('我都用繁中,專案是 pnpm', '好的') });
  assert.deepEqual(facts, ['使用者偏好繁體中文', '專案用 pnpm']);
  // 過濾 existing
  const f2 = await extractFacts({ ...base, streamFn: streamReturning('["專案用 pnpm","新事實"]'), messages: msgs('x', 'y'), existing: ['專案用 pnpm'] });
  assert.deepEqual(f2, ['新事實']);
  // 空對話 → 不呼叫,回 []
  assert.deepEqual(await extractFacts({ ...base, streamFn: streamReturning('["不該出現"]'), messages: [] }), []);
  // streamFn 丟錯 → 容錯回 []
  assert.deepEqual(await extractFacts({ ...base, streamFn: () => { throw new Error('boom'); }, messages: msgs('a', 'b') }), []);
});

test('kernel：api.extractMemory 把萃取結果存進 memory', async () => {
  const cwd = tmp();
  try {
    const k = createKernel(createGeneralPack({ cwd }), {
      cwd, model: { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 }, getApiKey: () => 'k',
      streamFn: streamReturning('["使用者在加州","偏好 TypeScript"]'),
    });
    const r = await k.extractMemory({ messages: msgs('我在加州,喜歡 TypeScript', '了解') });
    assert.deepEqual(r.extracted, ['使用者在加州', '偏好 TypeScript']);
    assert.ok(k.memory.list().includes('使用者在加州'));
    // 重跑同對話 → 已存的被過濾,不重複
    const r2 = await k.extractMemory({ messages: msgs('我在加州,喜歡 TypeScript', '了解') });
    assert.deepEqual(r2.extracted, []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('kernel：autoExtractMemory 在 runTurn 後非阻塞萃取（result.memoryExtraction）', async () => {
  const cwd = tmp();
  try {
    // 分流 fake：萃取器 prompt → 回事實；一般回合 → 回普通訊息
    const branchStream = (_m, ctx) => {
      const isExtract = /記憶萃取器/.test(ctx.systemPrompt);
      const out = isExtract ? '["使用者偏好深色模式"]' : '好的,已處理。';
      return { async *[Symbol.asyncIterator]() { yield { type: 'done' }; }, result: async () => ({ role: 'assistant', content: [{ type: 'text', text: out }], usage: { input: 1, output: 1 } }) };
    };
    let extractedEvent = null;
    const k = createKernel(createGeneralPack({ cwd }), {
      cwd, model: { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 }, getApiKey: () => 'k',
      streamFn: branchStream, autoExtractMemory: true,
    });
    const r = await k.runTurn('我之後都要用深色模式', { onEvent: (e) => { if (e.type === 'memory_extracted') extractedEvent = e; } });
    assert.ok(r.memoryExtraction, '應掛上非阻塞萃取 promise');
    const ex = await r.memoryExtraction;            // 需要時可 await
    assert.deepEqual(ex.extracted, ['使用者偏好深色模式']);
    assert.ok(k.memory.list().includes('使用者偏好深色模式'));
    assert.deepEqual(extractedEvent?.facts, ['使用者偏好深色模式']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
