// init 導引：buildConfig 純函數 + 產出可被 loadModel 讀回。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, PRESETS } from '../src/app/init.js';
import { loadModel } from '../src/app/providers.js';

const answers = (o = {}) => ({ providerName: 'minimax', baseUrl: 'https://api.minimaxi.com/anthropic', api: 'anthropic-messages', modelId: 'MiniMax-M2.7', modelName: 'MiniMax M2.7', contextWindow: 1000192, maxTokens: 131072, apiKey: '${MINIMAX_API_KEY}', ...o });

test('PRESETS 至少含常見 provider 且結構完整', () => {
  for (const k of ['minimax', 'anthropic', 'openai', 'deepseek', 'custom']) {
    assert.ok(PRESETS[k], `缺 ${k}`);
    assert.ok(PRESETS[k].api && 'baseUrl' in PRESETS[k] && PRESETS[k].model);
  }
});

test('buildConfig 產出正確結構 + defaultModel', () => {
  const cfg = buildConfig(answers());
  assert.equal(cfg.defaultModel, 'MiniMax-M2.7');
  assert.equal(cfg.providers.minimax.api, 'anthropic-messages');
  assert.equal(cfg.providers.minimax.models[0].contextWindow, 1000192);
  assert.equal(cfg.providers.minimax.apiKey, '${MINIMAX_API_KEY}');
});

test('buildConfig 合併既有 providers（不覆蓋他人）', () => {
  const existing = { defaultModel: 'gpt-4o', providers: { openai: { baseUrl: 'x', apiKey: 'y', api: 'openai-completions', models: [{ id: 'gpt-4o' }] } } };
  const cfg = buildConfig(answers(), existing);
  assert.ok(cfg.providers.openai, '既有 openai 應保留');
  assert.ok(cfg.providers.minimax, '新 minimax 應加入');
  assert.equal(cfg.defaultModel, 'MiniMax-M2.7', 'defaultModel 應更新為新 model');
});

test('產出的設定能被 loadModel 讀回（env apiKey 解析）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xk-init-'));
  const path = join(dir, 'providers.json');
  try {
    writeFileSync(path, JSON.stringify(buildConfig(answers({ apiKey: '${TEST_KEY_XK}' })), null, 2));
    process.env.TEST_KEY_XK = 'secret-123';
    const { model, getApiKey } = loadModel(undefined, path);
    assert.equal(model.id, 'MiniMax-M2.7');
    assert.equal(model.api, 'anthropic-messages');
    assert.equal(getApiKey(), 'secret-123');
  } finally { delete process.env.TEST_KEY_XK; rmSync(dir, { recursive: true, force: true }); }
});
