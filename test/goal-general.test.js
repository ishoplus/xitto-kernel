// goal loop + general pack。runGoal 用 fake provider 驅動（達成/停滯）；general pack 註冊與工具。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@mariozechner/pi-ai';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const FAKE_MODEL = { id: 'fake', provider: 'fake', api: 'openai-completions', baseUrl: '', input: ['text'], output: ['text'], contextWindow: 32000, maxTokens: 4096, cost: {} };
const textMsg = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }], stopReason: 'stop', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const toolCallMsg = (name, args) => ({ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name, arguments: args }], stopReason: 'toolUse', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const streamOf = (m) => { const s = new AssistantMessageEventStream(); s.push({ type: 'start', partial: m }); s.push({ type: 'done', reason: m.stopReason, message: m }); return s; };

const turnProvider = () => () => streamOf(textMsg('我做了一些事。'));
// 注入式驗收：第 doneOnRound 次回 done（不走網路，取代真實 checkGoal）
function fakeJudge(doneOnRound) { let n = 0; return async () => { const done = (++n) >= doneOnRound; return { done, remaining: done ? '' : '還要再做一點' }; }; }

test('general pack：註冊 + 工具齊（含 web_search/web_fetch）', () => {
  const k = createKernel(createGeneralPack());
  for (const n of ['read', 'ls', 'write', 'edit', 'bash', 'web_fetch', 'web_search']) assert.ok(k.registry.has(n), n);
  assert.ok(k.registry.readOnlyNames().includes('web_search'));
  assert.deepEqual([...k.mutatingTools].sort(), ['bash', 'edit', 'write']);
});

test('runGoal：驗收第 2 輪達成 → done', async () => {
  const k = createKernel(createGeneralPack(), { model: FAKE_MODEL, getApiKey: () => 'k', streamFn: turnProvider(), checkGoal: fakeJudge(2) });
  const rounds = [];
  const r = await k.runGoal('做某事', { maxRounds: 5, onRound: ({ round }) => rounds.push(round) });
  assert.equal(r.done, true);
  assert.equal(r.rounds, 2);
  assert.deepEqual(rounds, [1, 2]);
});

test('runGoal：一直未達成 + 無改動 → 連續無進展停止', async () => {
  const k = createKernel(createGeneralPack(), { model: FAKE_MODEL, getApiKey: () => 'k', streamFn: turnProvider(), checkGoal: fakeJudge(999) });
  const r = await k.runGoal('永遠做不完', { maxRounds: 10 });
  assert.equal(r.done, false);
  assert.equal(r.stalled, true);
  assert.ok(r.rounds <= 4, '應在無進展上限附近停止');
});

test('runGoal：agent 持續工作但驗收連續壞掉 → verifyBroken（不空轉到上限）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vb-'));
  try {
    let call = 0;
    // 每輪：先 write（mutating→turnModified=true，避開無進展停止）再 text 收尾
    const provider = () => { call++; return (call % 2 === 1) ? streamOf(toolCallMsg('write', { path: `f${call}.txt`, content: 'x' })) : streamOf(textMsg('做了一點')); };
    const judgeErr = async () => ({ done: false, remaining: '(壞掉)', error: true });
    const k = createKernel(createGeneralPack({ cwd: dir }), { cwd: dir, model: FAKE_MODEL, getApiKey: () => 'k', streamFn: provider, checkGoal: judgeErr });
    const r = await k.runGoal('x', { maxRounds: 12 });
    assert.equal(r.verifyBroken, true);
    assert.equal(r.rounds, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runGoal：drainSteer 把中途補充折進該輪指令', async () => {
  const seen = [];
  const provider = (_m, ctx) => { for (const m of ctx.messages) if (m.role === 'user') for (const c of (m.content || [])) if (c.type === 'text') seen.push(c.text); return streamOf(textMsg('好')); };
  let drained = false;
  const drainSteer = () => { if (drained) return []; drained = true; return ['請改用繁體中文']; };
  const k = createKernel(createGeneralPack(), { model: FAKE_MODEL, getApiKey: () => 'k', streamFn: provider, checkGoal: fakeJudge(1) });
  await k.runGoal('做某事', { maxRounds: 3, drainSteer });
  assert.ok(seen.some((t) => t.includes('請改用繁體中文')), '補充應折進指令送進 LLM');
});

test('runGoal：無 model → 報錯', async () => {
  const k = createKernel(createGeneralPack(), {});
  await assert.rejects(() => k.runGoal('x'), /需要 config\.model/);
});

test('runTurn 回傳 turnModified（goal loop 無進展偵測用）', async () => {
  const k = createKernel(createCodingPack(), { model: FAKE_MODEL, getApiKey: () => 'k', streamFn: () => streamOf(textMsg('只說話')) });
  const r = await k.runTurn('hi');
  assert.equal(r.turnModified, false);
});
