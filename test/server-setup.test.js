// 初始設定引導：缺 providers.json 時不崩潰，改開設定頁；表單 → providers.json 組裝與驗證。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSetupConfig, startSetupServer, mergeSetupConfig } from '../src/app/server.js';

test('mergeSetupConfig：新增 provider 不覆蓋既有；保留既有 defaultModel', () => {
  const base = { defaultModel: 'MiniMax-M2', providers: { minimax: { api: 'openai-completions', baseUrl: 'https://api.minimaxi.com/v1', apiKey: 'k1', models: [{ id: 'MiniMax-M2', name: 'M2' }] } } };
  const merged = mergeSetupConfig(base, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'k2', modelId: 'deepseek-chat' });
  assert.equal(merged.defaultModel, 'MiniMax-M2', '不偷改全域預設');
  assert.ok(merged.providers.minimax, '既有 provider 保留');
  assert.equal(merged.providers.deepseek.models[0].id, 'deepseek-chat', '新 provider 加入');
});

test('mergeSetupConfig：同 provider 加新 model（去重更新）；base 為 null → 等同新建', () => {
  const base = { defaultModel: 'gpt-4o', providers: { openai: { api: 'openai-completions', baseUrl: 'u', apiKey: 'k', models: [{ id: 'gpt-4o', name: 'old' }] } } };
  const merged = mergeSetupConfig(base, { provider: 'openai', baseUrl: 'u', apiKey: 'k', modelId: 'gpt-4o-mini' });
  assert.equal(merged.providers.openai.models.length, 2, '同 provider 追加 model');
  const upd = mergeSetupConfig(base, { provider: 'openai', baseUrl: 'u', apiKey: 'k', modelId: 'gpt-4o', modelName: 'new' });
  assert.equal(upd.providers.openai.models.length, 1, '同 id → 更新不重複');
  assert.equal(upd.providers.openai.models[0].name, 'new');
  assert.deepEqual(mergeSetupConfig(null, { provider: 'x', baseUrl: 'u', apiKey: 'k', modelId: 'm' }), buildSetupConfig({ provider: 'x', baseUrl: 'u', apiKey: 'k', modelId: 'm' }));
});

test('mergeSetupConfig：makeDefault → 新 model 設為預設；否則保留既有', () => {
  const base = { defaultModel: 'gpt-4o', providers: { openai: { api: 'openai-completions', baseUrl: 'u', apiKey: 'k', models: [{ id: 'gpt-4o', name: 'x' }] } } };
  const keep = mergeSetupConfig(base, { provider: 'deepseek', baseUrl: 'u', apiKey: 'k', modelId: 'deepseek-chat' });
  assert.equal(keep.defaultModel, 'gpt-4o', '未勾 → 保留既有預設');
  const flip = mergeSetupConfig(base, { provider: 'deepseek', baseUrl: 'u', apiKey: 'k', modelId: 'deepseek-chat', makeDefault: true });
  assert.equal(flip.defaultModel, 'deepseek-chat', 'makeDefault → 切為新 model');
});

test('buildSetupConfig：完整表單 → 正確的 providers.json 結構', () => {
  const cfg = buildSetupConfig({ provider: 'openai', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', modelId: 'gpt-4o', modelName: 'GPT-4o' });
  assert.equal(cfg.defaultModel, 'gpt-4o');
  const p = cfg.providers.openai;
  assert.equal(p.api, 'openai-completions');
  assert.equal(p.baseUrl, 'https://api.openai.com/v1');
  assert.equal(p.apiKey, 'sk-x');
  assert.deepEqual(p.models, [{ id: 'gpt-4o', name: 'GPT-4o' }]);
});

test('buildSetupConfig：modelName 留白 → 用 modelId；api 留白 → 預設 openai-completions', () => {
  const cfg = buildSetupConfig({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'k', modelId: 'deepseek-chat' });
  assert.equal(cfg.providers.deepseek.models[0].name, 'deepseek-chat');
  assert.equal(cfg.providers.deepseek.api, 'openai-completions');
});

test('buildSetupConfig：進階數值 >0 才寫入；缺必填則拋錯', () => {
  const cfg = buildSetupConfig({ provider: 'x', baseUrl: 'u', apiKey: 'k', modelId: 'm', contextWindow: 128000, maxTokens: 0 });
  assert.equal(cfg.providers.x.models[0].contextWindow, 128000);
  assert.equal(cfg.providers.x.models[0].maxTokens, undefined, 'maxTokens=0 不寫入（用預設）');
  assert.throws(() => buildSetupConfig({ provider: 'x', baseUrl: 'u', apiKey: 'k' }), /必填/);
  assert.throws(() => buildSetupConfig({}), /必填/);
});

test('HTTP：設定引導 server 提供設定頁 + /health 標記 setup + 不完整表單 400', async () => {
  const srv = startSetupServer({ port: 0, configPath: '/tmp/__xk_setup_never_written.json' });
  await new Promise((r) => setTimeout(r, 150));   // startSetupServer 內部已 listen(0)，等它就緒
  try {
    const port = srv.address().port;
    const U = (p) => `http://localhost:${port}${p}`;
    const page = await fetch(U('/')).then((r) => r.text());
    assert.match(page, /初始設定/, '回設定頁');
    const h = await fetch(U('/health')).then((r) => r.json());
    assert.equal(h.mode, 'setup', 'health 標記 setup 模式');
    // 不完整表單 → 400（不會觸發熱重啟）
    const bad = await fetch(U('/v1/setup'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'x' }) });
    assert.equal(bad.status, 400);
    // 任意路徑都回設定頁（引導使用者）
    const any = await fetch(U('/whatever')).then((r) => r.text());
    assert.match(any, /初始設定/);
  } finally { srv.close(); }
});
