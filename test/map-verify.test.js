// 可寫 map-verify（序列 + 快照回滾）：逐項可寫回合 → 驗收 → 通過保留／未通過 undo 回滾。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const FAKE_MODEL = { id: 'fake', provider: 'fake', api: 'openai-completions', baseUrl: '', input: ['text'], output: ['text'], contextWindow: 32000, maxTokens: 4096, cost: {} };
const textMsg = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }], stopReason: 'stop', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const toolMsg = (name, args) => ({ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name, arguments: args }], stopReason: 'toolUse', provider: 'fake', model: 'fake', api: 'openai-completions', timestamp: 1 });
const streamOf = (m) => { const s = new AssistantMessageEventStream(); s.push({ type: 'start', partial: m }); s.push({ type: 'done', reason: m.stopReason, message: m }); return s; };
const fakeProvider = (turns) => { let i = 0; return () => streamOf(turns[Math.min(i++, turns.length - 1)]); };

// 用 coding pack 但刪掉 pack.verify（改用 item.verify 當閘門，避免 pack.verify 再 prompt）
const mkKernel = (dir, turns) => {
  const pack = createCodingPack({ cwd: dir });
  delete pack.verify;
  return createKernel(pack, { cwd: dir, model: FAKE_MODEL, getApiKey: () => 'k', streamFn: fakeProvider(turns) });
};

test('mapVerify：通過保留、未通過回滾（序列、失敗自動復原）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mv-'));
  try {
    const k = mkKernel(dir, [
      toolMsg('write', { path: 'a.txt', content: 'A' }), textMsg('done'),  // item1
      toolMsg('write', { path: 'b.txt', content: 'B' }), textMsg('done'),  // item2
    ]);
    const out = await k.mapVerify([
      { task: '建 a.txt', verify: 'true' },   // 通過 → 保留
      { task: '建 b.txt', verify: 'false' },  // 未通過 → 回滾
    ]);
    assert.equal(out.total, 2);
    assert.equal(out.passed, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[0].rolledBack, false);
    assert.equal(out.results[1].ok, false);
    assert.equal(out.results[1].rolledBack, true);
    assert.ok(existsSync(join(dir, 'a.txt')), '通過項保留');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A');
    assert.equal(existsSync(join(dir, 'b.txt')), false, '未通過項已回滾刪除（工作區保持乾淨）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mapVerify：無 verify → 不擋但標記未驗（不回滾）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mv2-'));
  try {
    const k = mkKernel(dir, [toolMsg('write', { path: 'c.txt', content: 'C' }), textMsg('done')]);
    const out = await k.mapVerify([{ task: '建 c.txt' }]); // 無 verify
    assert.equal(out.results[0].verified, false);
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[0].rolledBack, false);
    assert.ok(existsSync(join(dir, 'c.txt')), '未驗但有改動 → 保留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mapVerify：無 model → 清楚報錯', async () => {
  const k = createKernel(createCodingPack(), { getApiKey: () => 'k' });
  await assert.rejects(() => k.mapVerify([{ task: 'x', verify: 'true' }]), /需要 config\.model/);
});
