import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../src/app/providers.js';

const cfg = {
  defaultModel: 'M1',
  providers: {
    p1: { baseUrl: 'https://api.x/anthropic', api: 'anthropic-messages', apiKey: '${TEST_KEY_XYZ}', models: [{ id: 'M1', contextWindow: 1000 }] },
  },
};

test('buildModel：組裝 model 形狀 + 預設 model', () => {
  const { model } = buildModel(cfg);
  assert.equal(model.id, 'M1');
  assert.equal(model.provider, 'p1');
  assert.equal(model.api, 'anthropic-messages');
  assert.equal(model.contextWindow, 1000);
  assert.equal(model.maxTokens, 4096); // 預設
});

test('buildModel：apiKey 從 ${ENV} 解析', () => {
  process.env.TEST_KEY_XYZ = 'sk-test-123';
  const { getApiKey } = buildModel(cfg);
  assert.equal(getApiKey(), 'sk-test-123');
  delete process.env.TEST_KEY_XYZ;
});

test('buildModel：找不到 model → 報錯', () => {
  assert.throws(() => buildModel(cfg, 'nope'), /找不到 model/);
});
