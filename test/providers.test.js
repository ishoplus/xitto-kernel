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

test('buildModel：透傳 compat/thinkingLevelMap（內網 vendor 指定 thinkingFormat）', () => {
  const c = {
    defaultModel: 'qwen',
    providers: {
      internal: {
        baseUrl: 'http://llm.corp/v1', api: 'openai-completions', apiKey: 'k',
        compat: { supportsReasoningEffort: true }, // provider 級預設
        models: [
          { id: 'qwen', reasoning: true, compat: { thinkingFormat: 'qwen' }, thinkingLevelMap: { medium: 'high' } },
          { id: 'plain' }, // 無 compat → 不應冒出 compat 欄位
        ],
      },
    },
  };
  const { resolveModel } = buildModel(c);
  const q = resolveModel('qwen');
  assert.equal(q.reasoning, true);
  assert.equal(q.compat.thinkingFormat, 'qwen');       // model 級
  assert.equal(q.compat.supportsReasoningEffort, true); // provider 級合併進來
  assert.deepEqual(q.thinkingLevelMap, { medium: 'high' });
  assert.ok(!('thinkingLevelMap' in resolveModel('plain')));
});
