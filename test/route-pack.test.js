// 任務自動分流：依願望文字挑 pack。heuristic 確定性、classifyPack LLM 為主+備援+逾時保險。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicPack, classifyPack } from '../src/app/server.js';

test('heuristicPack：強訊號 → 對應領域；一般任務 → null（交給 general）', () => {
  assert.equal(heuristicPack('幫我修一個 login.js 的 bug 並跑單元測試'), 'coding');
  assert.equal(heuristicPack('做一份 2026 世界盃的深度研究報告，多來源查證'), 'deep-research');
  assert.equal(heuristicPack('對這個 SQLite 資料庫下 SQL 撈出本月訂單'), 'data-query');
  assert.equal(heuristicPack('把服務用 docker 部署到伺服器'), 'devops');
  assert.equal(heuristicPack('整理我的讀書筆記'), 'notes');
  assert.equal(heuristicPack('幫我設計這個登入頁的版面，要響應式 RWD'), 'uiux');
  assert.equal(heuristicPack('把這個資料夾的 md 整理成一份 index'), null, '一般任務不強分流 → general');
});

const fakeModel = { id: 'fake', provider: 'fake' };
const completeOf = (text) => async () => ({ content: [{ type: 'text', text }] });

test('classifyPack：LLM 回領域代號 → 採用', async () => {
  const got = await classifyPack('隨便講一句沒有關鍵字的需求', { model: fakeModel, getApiKey: () => 'k', complete: completeOf('coding') });
  assert.equal(got, 'coding');
});

test('classifyPack：LLM 回 "research" 別名 → deep-research', async () => {
  const got = await classifyPack('xxx', { model: fakeModel, getApiKey: () => 'k', complete: completeOf('research') });
  assert.equal(got, 'deep-research');
});

test('classifyPack：LLM 回垃圾 → 落到 heuristic（此處強訊號=coding）', async () => {
  const got = await classifyPack('修 bug', { model: fakeModel, getApiKey: () => 'k', complete: completeOf('天氣不錯') });
  assert.equal(got, 'coding');
});

test('classifyPack：LLM 拋錯 → 不炸，落到 heuristic / general', async () => {
  const boom = async () => { throw new Error('network'); };
  assert.equal(await classifyPack('部署 docker', { model: fakeModel, getApiKey: () => 'k', complete: boom }), 'devops');
  assert.equal(await classifyPack('整理檔案', { model: fakeModel, getApiKey: () => 'k', complete: boom }), 'general');
});

test('classifyPack：無 model / 無 key / 空目標 → 不呼叫 LLM，直接 heuristic / general', async () => {
  let called = false; const spy = async () => { called = true; return { content: [] }; };
  assert.equal(await classifyPack('修 bug', { complete: spy }), 'coding');         // 無 model
  assert.equal(await classifyPack('', { model: fakeModel, getApiKey: () => 'k', complete: spy }), 'general'); // 空目標
  assert.equal(await classifyPack('x', { model: fakeModel, getApiKey: () => null, complete: spy }), 'general'); // 無 key
  assert.equal(called, false, '上述情況都不該打 LLM');
});
