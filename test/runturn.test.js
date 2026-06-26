// runTurn 移植測試 — 用 fake provider 驅動真實 Agent loop，不走網路。
// 證明：LLM 的 toolCall 會經過 kernel 守衛鏈，通過才執行、被擋則把理由回灌續跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@mariozechner/pi-ai';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const FAKE_MODEL = { id: 'fake', provider: 'fake', api: 'openai-completions', baseUrl: '', input: ['text'], output: ['text'], contextWindow: 32000, maxTokens: 4096, cost: {} };
const textMsg = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }], stopReason: 'stop', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const toolMsg = (name, args) => ({ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name, arguments: args }], stopReason: 'toolUse', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const streamOf = (m) => { const s = new AssistantMessageEventStream(); s.push({ type: 'start', partial: m }); s.push({ type: 'done', reason: m.stopReason, message: m }); return s; };
const fakeProvider = (turns) => { let i = 0; return () => streamOf(turns[Math.min(i++, turns.length - 1)]); };

test('runTurn：LLM 呼叫工具 → 過守衛 → 執行 → 回灌 → 收尾', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), {
      cwd: dir, model: FAKE_MODEL, getApiKey: () => 'k',
      streamFn: fakeProvider([toolMsg('write', { path: 'out.txt', content: 'hi' }), textMsg('完成')]),
    });
    const events = [];
    const { text, messages } = await k.runTurn('建一個 out.txt', { onEvent: (e) => events.push(e.type) });

    assert.equal(text, '完成');
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'toolResult', 'assistant']);
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'hi', '工具應真的執行');
    assert.ok(events.includes('tool_execution_end'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTurn：守衛擋下工具（read-before-edit）→ 理由回灌、檔案不變、loop 續跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt2-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const k = createKernel(createCodingPack({ cwd: dir }), {
      cwd: dir, model: FAKE_MODEL, getApiKey: () => 'k',
      // 第一輪：未 read 就 edit（會被守衛擋）；第二輪：模型改口收尾
      streamFn: fakeProvider([toolMsg('edit', { path: 'a.txt', oldText: 'hello', newText: 'hi' }), textMsg('我先讀再改')]),
    });
    const { messages } = await k.runTurn('改 a.txt');

    const toolResult = messages.find((m) => m.role === 'toolResult');
    assert.equal(toolResult.isError, true);
    assert.match(toolResult.content[0].text, /read-before-edit/);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'hello', '被擋 → 檔案不變');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTurn：缺 model → 清楚報錯', async () => {
  const k = createKernel(createCodingPack(), { getApiKey: () => 'k' });
  await assert.rejects(() => k.runTurn('hi'), /需要 config\.model/);
});
