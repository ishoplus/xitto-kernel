// verify + contextFiles 兩個 slot 接通測試。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { createKernel } from '../src/kernel/index.js';

const FAKE_MODEL = { id: 'fake', provider: 'fake', api: 'openai-completions', baseUrl: '', input: ['text'], output: ['text'], contextWindow: 32000, maxTokens: 4096, cost: {} };
const textMsg = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }], stopReason: 'stop', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const toolMsg = (name) => ({ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name, arguments: {} }], stopReason: 'toolUse', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const streamOf = (m) => { const s = new AssistantMessageEventStream(); s.push({ type: 'start', partial: m }); s.push({ type: 'done', reason: m.stopReason, message: m }); return s; };
const fakeProvider = (turns) => { let i = 0; return () => streamOf(turns[Math.min(i++, turns.length - 1)]); };

const touchTool = () => ({ name: 'touch', label: 'touch', description: '改動', mutating: true, parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'done' }] }) });

// ── contextFiles ──
test('contextFiles：從 cwd 載入並注入 systemPrompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-'));
  try {
    writeFileSync(join(dir, 'RULES.md'), '# 規範\n一律用繁體中文。');
    const k = createKernel({ name: 'x', systemPrompt: 'base', contextFiles: ['RULES.md'], tools: () => [] }, { cwd: dir });
    assert.match(k.systemPrompt, /專案規範/);
    assert.match(k.systemPrompt, /一律用繁體中文/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('contextFiles：逐層往上找（在父目錄）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctxup-'));
  try {
    writeFileSync(join(root, 'AGENTS.md'), '父層規範');
    const sub = join(root, 'a', 'b'); mkdirSync(sub, { recursive: true });
    const k = createKernel({ name: 'x', systemPrompt: 'base', contextFiles: ['AGENTS.md'], tools: () => [] }, { cwd: sub });
    assert.match(k.systemPrompt, /父層規範/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('contextFiles：找不到檔 → 不注入（systemPrompt 無規範區）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxno-'));
  try {
    const k = createKernel({ name: 'x', systemPrompt: 'base', contextFiles: ['NOPE.md'], tools: () => [] }, { cwd: dir });
    assert.doesNotMatch(k.systemPrompt, /專案規範/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── verify ──
test('verify：失敗 → 回灌讓 agent 修正 → 再驗收通過', async () => {
  let verifyCalls = 0;
  const pack = {
    name: 'v', systemPrompt: 's', tools: () => [touchTool()],
    verify: {
      shouldRun: (ctx) => ctx.turnModified,
      run: async () => { verifyCalls++; return { ok: verifyCalls >= 2, output: verifyCalls < 2 ? 'lint 失敗' : '' }; },
      maxRounds: 3,
    },
  };
  const events = [];
  const k = createKernel(pack, {
    model: FAKE_MODEL, getApiKey: () => 'k',
    // 每輪都先 touch（改動）再 text 收尾
    streamFn: fakeProvider([toolMsg('touch'), textMsg('done1'), toolMsg('touch'), textMsg('done2')]),
  });
  await k.runTurn('做事', { onEvent: (e) => { if (e.type?.startsWith('verify')) events.push(e); } });

  assert.equal(verifyCalls, 2, 'verify 應跑兩次（失敗一次、通過一次）');
  const ends = events.filter((e) => e.type === 'verify_end');
  assert.equal(ends[0].ok, false);
  assert.equal(ends[1].ok, true);
});

test('verify：本輪未改動 → shouldRun=false → 不跑', async () => {
  let calls = 0;
  const pack = {
    name: 'v', systemPrompt: 's', tools: () => [touchTool()],
    verify: { shouldRun: (ctx) => ctx.turnModified, run: async () => { calls++; return { ok: true }; } },
  };
  const k = createKernel(pack, { model: FAKE_MODEL, getApiKey: () => 'k', streamFn: fakeProvider([textMsg('只講話沒改東西')]) });
  await k.runTurn('hi');
  assert.equal(calls, 0, '沒改動就不該跑驗收');
});
