// 情節層 + 相關性召回：斷詞、評分、記錄/去重、召回排序、自動注入 prompt。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEpisodes, episodeTerms, scoreEpisode } from '../src/kernel/episodes.js';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'xk-ep-'));

test('episodeTerms：ASCII 詞 + 中文 bigram', () => {
  const t = episodeTerms('修好 flask 的 CORS bug');
  assert.ok(t.includes('flask') && t.includes('cors') && t.includes('bug'));
  assert.ok(t.includes('修好'));   // 中文 bigram
});

test('scoreEpisode：相關的得分高、不相關得 0、tag 加權', () => {
  const now = Date.now();
  const ep = (summary, tags) => ({ summary, tags: tags || [], ts: new Date(now).toISOString() });
  const q = new Set(episodeTerms('flask cors 設定'));
  const relevant = scoreEpisode(q, ep('調整 flask 的 cors 白名單'), now);
  const irrelevant = scoreEpisode(q, ep('優化 react 元件渲染'), now);
  assert.ok(relevant > 0);
  assert.equal(irrelevant, 0);
  // tag 命中比僅 summary 命中分數高
  const viaTag = scoreEpisode(new Set(episodeTerms('deploy')), ep('做了一些事', ['deploy']), now);
  const viaSummaryOnce = scoreEpisode(new Set(episodeTerms('deploy')), ep('deploy 一次', []), now);
  assert.ok(viaTag >= viaSummaryOnce);
});

test('record：寫 jsonl + 去重（高度相似跳過）', () => {
  const dir = tmp(); const file = join(dir, 'e.jsonl');
  try {
    const ep = createEpisodes(file);
    assert.ok(ep.record({ summary: '修好 requests 的 timeout 處理', tags: ['requests', 'bug'] }).recorded);
    assert.ok(existsSync(file));
    assert.equal(ep.count(), 1);
    // 幾乎相同 → skipped
    const dup = ep.record({ summary: '修好 requests 的 timeout 處理', tags: ['requests'] });
    assert.ok(dup.skipped);
    assert.equal(ep.count(), 1);
    // 不同 → 新增
    assert.ok(ep.record({ summary: '加上 retry 機制給 http client' }).recorded);
    assert.equal(ep.count(), 2);
    assert.equal(ep.record({ summary: '  ' }).error, 'summary 不可為空');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recall：只回相關、按分數排序、limit 生效', () => {
  const dir = tmp(); const file = join(dir, 'e.jsonl');
  try {
    const ep = createEpisodes(file);
    ep.record({ summary: '調 flask CORS 白名單修好跨域', tags: ['flask', 'cors'] });
    ep.record({ summary: '優化資料庫查詢加索引', tags: ['db'] });
    ep.record({ summary: 'flask 路由加上錯誤處理', tags: ['flask'] });
    const hits = ep.recall('flask cors 怎麼設', 5);
    assert.ok(hits.length >= 1);
    assert.match(hits[0].summary, /CORS/);            // 最相關的排第一
    assert.ok(!hits.some((h) => /資料庫/.test(h.summary))); // 不相關的不召回
    assert.equal(ep.recall('完全無關的太空火箭', 5).length, 0);
    assert.ok(ep.recall('flask', 1).length <= 1);     // limit
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recallSection：有相關回 prompt 區塊、無相關回空字串', () => {
  const dir = tmp(); const file = join(dir, 'e.jsonl');
  try {
    const ep = createEpisodes(file);
    ep.record({ summary: '部署到 staging 前要先跑 migration', tags: ['deploy'], outcome: 'success' });
    assert.match(ep.recallSection('怎麼部署到 staging'), /相關的過往經驗[\s\S]*migration/);
    assert.equal(ep.recallSection('今天天氣如何'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kernel：episode 工具注入 + 自動召回注入 runTurn 的 systemPrompt（透過 streamFn 攔截）', async () => {
  const cwd = tmp();
  try {
    const model = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
    // 先用一個 kernel 記一筆情節
    const k0 = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k' });
    assert.ok(k0.registry.has('episode_record') && k0.registry.has('episode_recall'));
    k0.episodes.record({ summary: '修好 flask app 的 CORS 設定', tags: ['flask', 'cors'], outcome: 'success' });

    // 攔截 streamFn 看 runTurn 實際送出的 systemPrompt 是否含召回區塊
    let seenPrompt = '';
    const fakeStream = (_model, llmContext) => {
      seenPrompt = llmContext.systemPrompt;
      const finalMessage = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: finalMessage }; }, result: async () => finalMessage };
    };
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k', streamFn: fakeStream });
    await k.runTurn('我要處理 flask 的 cors 問題', {});
    assert.match(seenPrompt, /相關的過往經驗/);
    assert.match(seenPrompt, /CORS 設定/);

    // 不相關的 input → 不注入召回區塊
    await k.runTurn('幫我寫一首詩', {});
    assert.doesNotMatch(seenPrompt, /相關的過往經驗/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
