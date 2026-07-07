// 思考強度控制測試 — 證明 runTurn 把 thinkingLevel 正確轉成送給 provider 的 reasoning 選項。
// 優先序：opts.thinkingLevel > config.thinkingLevel > model.reasoning 預設（reasoning:true → 'medium'）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const textMsg = { role: 'assistant', content: [{ type: 'text', text: '完成' }], stopReason: 'stop', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 };
const streamOf = () => { const s = new AssistantMessageEventStream(); s.push({ type: 'start', partial: textMsg }); s.push({ type: 'done', reason: 'stop', message: textMsg }); return s; };

// fake streamFn：記下每次收到的 opts.reasoning，並回一個正常串流。
function capturingKernel(modelOverrides, kernelCfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'think-'));
  const seen = [];
  const model = { id: 'fake', provider: 'fake', api: 'openai-completions', baseUrl: '', input: ['text'], output: ['text'], contextWindow: 32000, maxTokens: 4096, cost: {}, ...modelOverrides };
  const k = createKernel(createCodingPack({ cwd: dir }), {
    cwd: dir, model, getApiKey: () => 'k', logging: false,
    streamFn: async (_m, _c, opts) => { seen.push(opts.reasoning); return streamOf(); },
    ...kernelCfg,
  });
  return { k, seen, dir };
}

test('reasoning model 預設 → reasoning=medium', async () => {
  const { k, seen, dir } = capturingKernel({ reasoning: true });
  try { await k.runTurn('hi'); assert.equal(seen[0], 'medium'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('非 reasoning model 預設 → reasoning=undefined（thinkingLevel off）', async () => {
  const { k, seen, dir } = capturingKernel({ reasoning: false });
  try { await k.runTurn('hi'); assert.equal(seen[0], undefined); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('opts.thinkingLevel 覆蓋 → reasoning=high', async () => {
  const { k, seen, dir } = capturingKernel({ reasoning: true });
  try { await k.runTurn('hi', { thinkingLevel: 'high' }); assert.equal(seen[0], 'high'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('opts.thinkingLevel=off 強制關閉推理型 model → reasoning=undefined', async () => {
  const { k, seen, dir } = capturingKernel({ reasoning: true });
  try { await k.runTurn('hi', { thinkingLevel: 'off' }); assert.equal(seen[0], undefined); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config.thinkingLevel 生效 → reasoning=low', async () => {
  const { k, seen, dir } = capturingKernel({ reasoning: true }, { thinkingLevel: 'low' });
  try { await k.runTurn('hi'); assert.equal(seen[0], 'low'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
