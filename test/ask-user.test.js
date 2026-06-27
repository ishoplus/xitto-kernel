// 澄清通道：kernel ask_user 工具（app 注入 askUser）+ 任務佇列 pause/answer/resume。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';
import { createTaskStore } from '../src/app/server.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'xk-ask-'));
const model = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
const tick = () => new Promise((r) => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('kernel：未提供 askUser → 無 ask_user 工具；提供 → 有，且把回答回給 agent', async () => {
  const cwd = tmp();
  try {
    const k0 = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k' });
    assert.equal(k0.registry.has('ask_user'), false);

    let askedWith = null;
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k', askUser: async (q) => { askedWith = q; return '用 TypeScript'; } });
    assert.ok(k.registry.has('ask_user'));
    const r = await k.runTool('ask_user', { question: '用哪個語言?', options: ['JS', 'TS'] });
    assert.deepEqual(askedWith, { question: '用哪個語言?', options: ['JS', 'TS'] });
    assert.deepEqual(JSON.parse(r.result.content[0].text), { answer: '用 TypeScript' });
    assert.match(k.systemPrompt, /ask_user/);   // prompt 有節制使用的引導
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('kernel：askUser 回空 → 提示 agent 用合理預設、別再追問', async () => {
  const cwd = tmp();
  try {
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k', askUser: async () => '' });
    const r = await k.runTool('ask_user', { question: '?' });
    assert.match(JSON.parse(r.result.content[0].text).answer, /合理預設/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('任務佇列：ask → needs-input 暫停 → answer → 續跑完成', async () => {
  const gate = defer();
  // runJob：先 ask,拿到回答後才完成
  const store = createTaskStore({
    runJob: async (spec, emit, ask) => {
      emit({ type: 'text', delta: '開工' });
      const ans = await ask({ question: '要中文還英文?', options: ['中', '英'] });
      gate.resolve();
      return { sessionId: 's', text: `用「${ans}」完成` };
    },
  });
  const t = store.enqueue({ pack: 'general', mode: 'goal', goal: 'x' });
  await tick(); await tick();
  // 應停在 needs-input,帶著問題
  assert.equal(store.get(t.id).status, 'needs-input');
  assert.equal(store.view(t.id).pending.question, '要中文還英文?');
  assert.deepEqual(store.view(t.id).pending.options, ['中', '英']);
  // 還沒答 → 不會完成
  assert.equal(store.get(t.id).result, null);
  // 回答 → 解除暫停
  assert.equal(store.answer(t.id, '中'), true);
  await gate.promise; await tick(); await tick();
  assert.equal(store.get(t.id).status, 'done');
  assert.match(store.result(t.id).result.text, /用「中」完成/);
  // 事件流含 needs_input 與 answered
  const types = store.get(t.id).events.map((e) => e.type);
  assert.ok(types.includes('needs_input') && types.includes('answered'));
});

test('任務佇列：answer 對沒有待答的任務 → 回 false', async () => {
  const store = createTaskStore({ runJob: async () => ({ text: 'ok' }) });
  const t = store.enqueue({});
  await tick(); await tick();
  assert.equal(store.answer(t.id, 'x'), false); // 已完成,無待答
  assert.equal(store.answer('不存在', 'x'), false);
});
