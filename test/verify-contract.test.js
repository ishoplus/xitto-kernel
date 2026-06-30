// 「完成定義」契約：pack.verify 的最終裁決＋證據要掛到 runTurn 的 result.verify，
// 讓呼叫端能誠實呈現「通過/未通過」，而非把未驗收的成品當 done。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const FAKE_MODEL = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };

// 假 streamFn：記憶萃取器回 []，一般回合回「完成」。
const sayDone = (_m, ctx) => {
  if (/記憶萃取/.test(ctx?.systemPrompt || '')) {
    return { async *[Symbol.asyncIterator]() { yield { type: 'done' }; }, result: async () => ({ role: 'assistant', content: [{ type: 'text', text: '[]' }] }) };
  }
  const msg = { role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: { input: 1, output: 1 } };
  return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: msg }; }, result: async () => msg };
};

function kernelWithVerify(cwd, verdict) {
  const pack = createGeneralPack({ cwd });
  pack.verify = { maxRounds: 1, shouldRun: () => true, run: async () => verdict };
  return createKernel(pack, { cwd, model: FAKE_MODEL, getApiKey: () => 'k', streamFn: sayDone });
}

test('runTurn.verify：通過 → {ran:true, ok:true, output, rounds}', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'xk-vc-'));
  try {
    const r = await kernelWithVerify(cwd, { ok: true, output: 'all good' }).runTurn('做點事');
    assert.ok(r.verify, 'result.verify 應存在');
    assert.equal(r.verify.ran, true);
    assert.equal(r.verify.ok, true);
    assert.equal(r.verify.output, 'all good');
    assert.equal(r.verify.rounds, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('runTurn.verify：失敗 → ok:false（誠實回報未通過，不當 done）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'xk-vc-'));
  try {
    const r = await kernelWithVerify(cwd, { ok: false, output: 'lint error: x' }).runTurn('做點事');
    assert.equal(r.verify.ran, true);
    assert.equal(r.verify.ok, false);
    assert.match(r.verify.output, /lint error/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('runTurn.verify：pack 無 verify → null（不適用）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'xk-vc-'));
  try {
    const pack = createGeneralPack({ cwd });
    delete pack.verify;
    const r = await createKernel(pack, { cwd, model: FAKE_MODEL, getApiKey: () => 'k', streamFn: sayDone }).runTurn('做點事');
    assert.equal(r.verify, null);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
