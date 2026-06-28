// 成品管理：content-type 對應、tmp/ 不算成品、view 帶 workspace。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentTypeFor, createTaskStore } from '../src/app/server.js';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const tick = () => new Promise((r) => setImmediate(r));

test('contentTypeFor：按副檔名給對的型別,未知→octet-stream', () => {
  assert.equal(contentTypeFor('report.md'), 'text/markdown');
  assert.equal(contentTypeFor('a.png'), 'image/png');
  assert.equal(contentTypeFor('data.json'), 'application/json');
  assert.equal(contentTypeFor('x.csv'), 'text/csv');
  assert.equal(contentTypeFor('slides.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(contentTypeFor('page.html'), 'text/html');
  assert.equal(contentTypeFor('weird.xyz'), 'application/octet-stream');
  assert.equal(contentTypeFor('noext'), 'application/octet-stream');
});

test('view：帶 workspace（給 UI 按專案分組）', async () => {
  const store = createTaskStore({ runJob: async () => ({}) });
  const t = store.enqueue({ mode: 'goal', goal: 'x', workspace: 'essay' });
  assert.equal(store.view(t.id).workspace, 'essay');
  const t2 = store.enqueue({ mode: 'goal', goal: 'y' });
  assert.equal(store.view(t2.id).workspace, 'default');
  await tick();
});

test('runOutcome：tmp/ 內的過程檔不算成品，根目錄的才算', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'xk-del-'));
  try {
    const model = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
    const streamFn = (_m, ctx) => {
      if (/記憶萃取器/.test(ctx.systemPrompt)) return { async *[Symbol.asyncIterator]() { yield { type: 'done' }; }, result: async () => ({ role: 'assistant', content: [{ type: 'text', text: '[]' }] }) };
      // 副作用：建一個成品 + 一個 tmp 過程檔
      mkdirSync(join(cwd, 'tmp'), { recursive: true });
      writeFileSync(join(cwd, 'report.md'), '# 報告');
      writeFileSync(join(cwd, 'tmp', 'scratch.bin'), 'junk');
      const msg = { role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: { input: 1, output: 1 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: msg }; }, result: async () => msg };
    };
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k', streamFn, checkGoal: async () => ({ done: true }) });
    const o = await k.runOutcome('產出報告');
    assert.deepEqual(o.artifacts.created, ['report.md']);                 // 只有成品
    assert.ok(!o.artifacts.created.some((f) => f.includes('tmp')), 'tmp/ 過程檔不該列入成品');
    assert.match(k.systemPrompt, /tmp\/ 目錄/);                           // prompt 有引導
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
