// Phase A：自訂 agent 類型——從 <dataDir>/agents/*.md 載入具名類型（prompt + 工具白名單），
// spawn_agent 用 agentType 指定 → 以該類型的 system prompt + 工具子集跑子 agent。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';
import { createAgents } from '../src/kernel/agents.js';

const MODEL = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
const REVIEWER = `---
name: reviewer
description: 審查程式碼變更，找 bug 與風格問題。
tools: read, grep
---
你是嚴格的程式碼審查員，只讀不改，逐項列出問題（檔案:行 + 建議）。`;

// 寫一個 agent 類型定義到 <cwd>/.xitto-kernel/coding/agents/reviewer.md
function seed(cwd) {
  const dir = join(cwd, '.xitto-kernel', 'coding', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'reviewer.md'), REVIEWER);
}

test('createAgents：載入類型（name/description/tools/systemPrompt）', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'at-'));
  try {
    seed(cwd);
    const a = createAgents(join(cwd, '.xitto-kernel', 'coding', 'agents'));
    assert.equal(a.count(), 1);
    const list = a.list();
    assert.equal(list[0].name, 'reviewer');
    assert.deepEqual(list[0].tools, ['read', 'grep']);
    assert.match(a.get('reviewer').systemPrompt, /嚴格的程式碼審查員/);
    assert.match(a.promptSection(), /reviewer/);
    assert.equal(a.get('不存在'), null);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('系統提示注入「可用的 agent 類型」', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'at2-'));
  try {
    seed(cwd);
    const k = createKernel(createCodingPack({ cwd }), { cwd, model: MODEL, getApiKey: () => 'k' });
    assert.match(k.systemPrompt, /可用的 agent 類型/);
    assert.match(k.systemPrompt, /reviewer/);
    assert.equal(k.agents.count(), 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('spawn_agent agentType → 用該類型的 system prompt（攔截 streamFn 驗證）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'at3-'));
  try {
    seed(cwd);
    let seenPrompt = null;
    const capture = (_m, ctx) => {
      seenPrompt = ctx?.systemPrompt || '';
      const msg = { role: 'assistant', content: [{ type: 'text', text: '審查完成' }], usage: { input: 1, output: 1 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: msg }; }, result: async () => msg };
    };
    const k = createKernel(createCodingPack({ cwd }), { cwd, model: MODEL, getApiKey: () => 'k', streamFn: capture });
    const r = await k.runTool('spawn_agent', { task: '審查 x.js', agentType: 'reviewer' });
    assert.match(JSON.stringify(r.result), /審查完成/);
    assert.match(seenPrompt, /嚴格的程式碼審查員/, '應用 reviewer 的 system prompt');
    assert.doesNotMatch(seenPrompt, /唯讀調查子 agent/, '不應是預設投查員 prompt');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('spawn_agent 未知/未給 agentType → 用預設唯讀調查員 prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'at4-'));
  try {
    let seenPrompt = null;
    const capture = (_m, ctx) => {
      seenPrompt = ctx?.systemPrompt || '';
      const msg = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: msg }; }, result: async () => msg };
    };
    const k = createKernel(createCodingPack({ cwd }), { cwd, model: MODEL, getApiKey: () => 'k', streamFn: capture });
    await k.runTool('spawn_agent', { task: '查點東西' }); // 無 agentType
    assert.match(seenPrompt, /唯讀調查子 agent/, '應用預設投查員 prompt');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
