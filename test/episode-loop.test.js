// ③ 私有脈絡複利：runOutcome 完成後自動記情節 → 下次相似任務自動召回（act→record→recall 閉環）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const MODEL = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
const sayDone = (_m, ctx) => {
  if (/記憶萃取/.test(ctx?.systemPrompt || '')) return { async *[Symbol.asyncIterator]() { yield { type: 'done' }; }, result: async () => ({ role: 'assistant', content: [{ type: 'text', text: '[]' }] }) };
  const msg = { role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: { input: 1, output: 1 } };
  return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: msg }; }, result: async () => msg };
};
const mk = (cwd, extra = {}) => createKernel(createGeneralPack({ cwd }), { cwd, model: MODEL, getApiKey: () => 'k', streamFn: sayDone, checkGoal: async () => ({ done: true }), ...extra });

test('runOutcome 後自動記情節，且相似任務可召回（閉環）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ep-'));
  try {
    const events = [];
    const k = mk(cwd);
    await k.runOutcome('整理這個資料夾的筆記成索引', { onEvent: (e) => { if (e.type === 'episode_recorded') events.push(e); } });
    assert.equal(k.episodes.count(), 1, '應自動記一筆情節');
    const ep = k.episodes.list()[0];
    assert.match(ep.summary, /整理.*索引/);
    assert.equal(ep.outcome, 'success');
    assert.ok(ep.tags.includes('general'), 'tag 應含 pack 名');
    assert.equal(events.length, 1, '應發 episode_recorded 事件');
    assert.ok(k.episodes.recall('整理筆記索引').length >= 1, '相似任務應召回剛記的情節');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('未達成 → outcome 標記非 success', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ep-x-'));
  try {
    const k = mk(cwd, { checkGoal: async () => ({ done: false, remaining: '還沒好' }) });
    await k.runOutcome('一個不會完成的任務', { maxRounds: 1 });
    const ep = k.episodes.list()[0];
    assert.ok(ep, '即使未完成也記情節（失敗也是經驗）');
    assert.notEqual(ep.outcome, 'success');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('autoRecordEpisode:false → 不自動記', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ep2-'));
  try {
    const k = mk(cwd, { autoRecordEpisode: false });
    await k.runOutcome('做一件事');
    assert.equal(k.episodes.count(), 0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('重複 goal → 去重（仍只 1 筆）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ep3-'));
  try {
    const k = mk(cwd);
    await k.runOutcome('重複的任務描述完全一樣');
    await k.runOutcome('重複的任務描述完全一樣');
    assert.equal(k.episodes.count(), 1, '相同 goal 應被去重');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
