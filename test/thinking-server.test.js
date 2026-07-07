// 思考模式 server 端整合 — /v1/models 帶 reasoning 能力與思考預設；/v1/settings/thinking 持久化且即時生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApp } from '../src/app/server.js';

const MODEL = { id: 'qwen', name: 'qwen', provider: 'internal', api: 'openai-completions', baseUrl: 'http://llm.corp/v1', reasoning: true, contextWindow: 32000, maxTokens: 4096, cost: {} };
const resolveModel = (id) => (id === 'qwen' ? MODEL : id === 'plain' ? { ...MODEL, id: 'plain', reasoning: false } : null);

async function withServer(baseDir, fn) {
  const app = createServerApp({
    model: MODEL, getApiKey: () => 'k', resolveModel,
    models: [{ id: 'qwen', name: 'qwen', provider: 'internal' }, { id: 'plain', name: 'plain', provider: 'internal' }],
    token: 't', baseDir, sandbox: false,
  });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  const H = { authorization: 'Bearer t', 'content-type': 'application/json' };
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: H }).then((r) => r.json());
  const post = (p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json());
  try { await fn({ get, post }); } finally { await new Promise((r) => app.close(r)); }
}

test('/v1/models：帶每模型 reasoning 能力 + 當前思考預設', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thsrv-'));
  try {
    await withServer(dir, async ({ get }) => {
      const j = await get('/v1/models');
      assert.equal(j.thinking, 'off'); // 未設 → off
      assert.equal(j.models.find((m) => m.id === 'qwen').reasoning, true);
      assert.equal(j.models.find((m) => m.id === 'plain').reasoning, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/v1/settings/thinking：儲存 → 持久化 settings.json + /v1/models 即時反映', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thsrv-'));
  try {
    await withServer(dir, async ({ get, post }) => {
      const saved = await post('/v1/settings/thinking', { thinking: 'high' });
      assert.equal(saved.ok, true);
      assert.equal(saved.thinking, 'high');
      assert.equal((await get('/v1/models')).thinking, 'high');      // live 生效
      assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).thinking, 'high'); // 落地
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/v1/settings/thinking：非法值 → 收斂為 off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thsrv-'));
  try {
    await withServer(dir, async ({ get, post }) => {
      await post('/v1/settings/thinking', { thinking: 'ultra' });
      assert.equal((await get('/v1/models')).thinking, 'off');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
