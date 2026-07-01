// 結果導向 runOutcome：交付物（產出/改動的檔案 + 摘要 + 達成與否）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'xk-oc-'));
const model = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };

// fake streamFn：在「回合」執行時對 cwd 做副作用（模擬 agent 產出檔案），回一段摘要。
const streamThatWrites = (cwd, sideEffect) => {
  let n = 0;
  return (_m, ctx) => {
    if (/記憶萃取器/.test(ctx.systemPrompt)) return { async *[Symbol.asyncIterator]() { yield { type: 'done' }; }, result: async () => ({ role: 'assistant', content: [{ type: 'text', text: '[]' }] }) };
    if (n++ === 0) sideEffect(cwd);
    const msg = { role: 'assistant', content: [{ type: 'text', text: '我建立了 report.md 並完成了目標。' }], usage: { input: 1, output: 1 } };
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: msg }; }, result: async () => msg };
  };
};

test('runOutcome：回傳交付物（新建檔列入 artifacts.created + summary + done）', async () => {
  const cwd = tmp();
  try {
    const k = createKernel(createGeneralPack({ cwd }), {
      cwd, model, getApiKey: () => 'k',
      streamFn: streamThatWrites(cwd, (d) => writeFileSync(join(d, 'report.md'), '# 報告\n完成')),
      checkGoal: async () => ({ done: true }),       // 注入驗收：一輪即達成
    });
    const o = await k.runOutcome('產出一份報告 report.md');
    assert.equal(o.done, true);
    assert.deepEqual(o.artifacts.created, ['report.md']);
    assert.deepEqual(o.artifacts.modified, []);
    assert.match(o.summary, /report\.md/);
    assert.equal(o.goal, '產出一份報告 report.md');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('runOutcome：改動既有檔 → 列入 modified；無變動 → 兩者皆空', async () => {
  const cwd = tmp();
  try {
    writeFileSync(join(cwd, 'existing.txt'), 'v1');
    const k = createKernel(createGeneralPack({ cwd }), {
      cwd, model, getApiKey: () => 'k', checkGoal: async () => ({ done: true }),
      streamFn: streamThatWrites(cwd, (d) => writeFileSync(join(d, 'existing.txt'), 'v2-changed')),
    });
    const o = await k.runOutcome('改一下 existing.txt');
    assert.deepEqual(o.artifacts.modified, ['existing.txt']);
    assert.deepEqual(o.artifacts.created, []);

    // 無副作用 → 無檔案變動
    const k2 = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k', checkGoal: async () => ({ done: true }), streamFn: streamThatWrites(cwd, () => {}) });
    const o2 = await k2.runOutcome('什麼都不用做');
    assert.deepEqual(o2.artifacts, { created: [], modified: [] });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('runGoal：驗收一直判未達成(查不到的目標) → 在幾輪內停止,不空轉到上限', async () => {
  const cwd = tmp();
  try {
    // fake：每回合只回文字（不改檔）；checkGoal 永遠未達成、回饋相同 → 模擬「繞圈」
    const fakeStream = (_m, ctx) => {
      const msg = { role: 'assistant', content: [{ type: 'text', text: '我又查了一下，還是找不到。' }], usage: { input: 1, output: 1 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: msg }; }, result: async () => msg };
    };
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k', streamFn: fakeStream, checkGoal: async () => ({ done: false, remaining: '尚未找到該資訊（不存在）' }) });
    const g = await k.runGoal('查一個不存在的資訊', { maxRounds: 12 });
    assert.equal(g.done, false);
    assert.ok(g.stalled, '應判定 stalled（繞圈）而非跑到上限');
    assert.ok(g.rounds <= 4, '應在幾輪內停,而非 12。實際：' + g.rounds);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('runGoal：唯讀任務(不改檔)但回饋逐輪演進 → 不在第 3 輪早停,能精修到達成', async () => {
  const cwd = tmp();
  try {
    // 每回合只回文字、不改檔（模擬研究/問答）；舊邏輯只看 turnModified → 第 3 輪必 STALLED
    const fakeStream = (_m) => {
      const msg = { role: 'assistant', content: [{ type: 'text', text: '查到一部分，繼續深入。' }], usage: { input: 1, output: 1 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: msg }; }, result: async () => msg };
    };
    // checkGoal：前 4 輪回「不同」的 remaining（演進＝有進展），第 5 輪達成
    let round = 0;
    const checkGoal = async () => { round++; return round >= 5 ? { done: true } : { done: false, remaining: `還缺第 ${round} 項資訊` }; };
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k', streamFn: fakeStream, checkGoal });
    const g = await k.runGoal('多步研究問答', { maxRounds: 12 });
    assert.equal(g.done, true, '回饋在演進 → 應持續精修到達成，而非第 3 輪 STALLED');
    assert.equal(g.rounds, 5);
    assert.ok(!g.stalled);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('runOutcome：.xitto-kernel 內部沉澱檔不算交付物', async () => {
  const cwd = tmp();
  try {
    const k = createKernel(createGeneralPack({ cwd }), {
      cwd, model, getApiKey: () => 'k', checkGoal: async () => ({ done: true }),
      // 副作用只寫到 .xitto-kernel（內部）→ 不應出現在 artifacts
      streamFn: streamThatWrites(cwd, (d) => { k.playbook.update('測試', 'npm test'); }),
    });
    const o = await k.runOutcome('記個手冊');
    assert.deepEqual(o.artifacts, { created: [], modified: [] });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
