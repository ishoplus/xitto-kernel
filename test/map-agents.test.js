// spawn_agents 平行 map：對 N 項各派唯讀子 agent，回每項結論（順序保留、上限截斷、友善錯誤）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const FAKE_MODEL = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };

// 假 streamFn：子 agent 不呼叫工具，直接回固定結論。
const okStream = () => {
  const msg = { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input: 1, output: 1 } };
  return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: msg }; }, result: async () => msg };
};
const parse = (r) => JSON.parse(r.result.content[0].text);

test('spawn_agents 註冊為唯讀', () => {
  const k = createKernel(createCodingPack());
  assert.ok(k.registry.has('spawn_agents'));
  assert.ok(k.registry.readOnlyNames().includes('spawn_agents'));
  assert.ok(![...k.mutatingTools].includes('spawn_agents'));
});

test('spawn_agents 平行跑 N 項 → 回每項結論，順序對應', async () => {
  const k = createKernel(createCodingPack(), { model: FAKE_MODEL, getApiKey: () => 'k', streamFn: okStream });
  const out = parse(await k.runTool('spawn_agents', { tasks: ['查 A', '查 B', '查 C'] }));
  assert.equal(out.count, 3);
  assert.deepEqual(out.results.map((x) => x.task), ['查 A', '查 B', '查 C']); // pool 保留索引順序
  assert.ok(out.results.every((x) => x.text === 'done'));
});

test('spawn_agents 超過上限 16 → 截斷並回報 dropped', async () => {
  const k = createKernel(createCodingPack(), { model: FAKE_MODEL, getApiKey: () => 'k', streamFn: okStream });
  const tasks = Array.from({ length: 18 }, (_, i) => `任務 ${i}`);
  const out = parse(await k.runTool('spawn_agents', { tasks }));
  assert.equal(out.count, 16);
  assert.equal(out.dropped, 2);
});

test('spawn_agents 整批韌性：個別子 agent 不順仍回滿 N 個結果、整批不崩', async () => {
  let n = 0;
  const flaky = () => { n++; if (n === 2) throw new Error('boom'); return okStream(); };
  const k = createKernel(createCodingPack(), { model: FAKE_MODEL, getApiKey: () => 'k', streamFn: flaky });
  const out = parse(await k.runTool('spawn_agents', { tasks: ['a', 'b', 'c'] }));
  assert.equal(out.count, 3, '整批回滿 3 項，不因單項問題崩掉');
  assert.ok(out.results.every((x) => 'text' in x || 'error' in x), '每項都有結果（text 或 error）');
});

test('spawn_agents 無 model / 空 tasks → 友善錯誤（不丟例外）', async () => {
  const k1 = createKernel(createCodingPack(), {}); // 無 model
  assert.match(JSON.stringify((await k1.runTool('spawn_agents', { tasks: ['x'] })).result), /無 model/);
  const k2 = createKernel(createCodingPack(), { model: FAKE_MODEL, getApiKey: () => 'k', streamFn: okStream });
  assert.match(JSON.stringify((await k2.runTool('spawn_agents', { tasks: [] })).result), /非空|皆為空/);
  assert.match(JSON.stringify((await k2.runTool('spawn_agents', { tasks: ['  ', ''] })).result), /皆為空/);
});
