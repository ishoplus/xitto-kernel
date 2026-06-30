// Phase B：可寫委派——delegate 把子任務交給 agent 類型，路由到 runTurn（重用守衛/沙箱/undo），
// 用該類型的 prompt + 工具白名單（含可寫）執行。對標 CC subagents 的可寫委派。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
const parse = (r) => JSON.parse(r.result.content[0].text);

const BUILDER = `---
name: builder
description: 依指示建立/修改檔案。
tools: write, read, edit
---
你是檔案建構子 agent，依指示精準建立或修改檔案。`;

function seed(cwd) {
  const dir = join(cwd, '.xitto-kernel', 'coding', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'builder.md'), BUILDER);
}

test('delegate：可寫委派 → 子 agent 實際改檔（經守衛），回 delegatedTo + 結論', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dg-'));
  try {
    seed(cwd);
    const k = createKernel(createCodingPack({ cwd }), {
      cwd, model: FAKE_MODEL, getApiKey: () => 'k',
      streamFn: fakeProvider([toolMsg('write', { path: 'out.txt', content: 'hi' }), textMsg('建好了')]),
    });
    const out = parse(await k.runTool('delegate', { agentType: 'builder', task: '建立 out.txt 內容 hi' }));
    assert.equal(out.delegatedTo, 'builder');
    assert.match(out.text, /建好了/);
    assert.ok(existsSync(join(cwd, 'out.txt')), '委派的子 agent 應真的改檔（可寫）');
    assert.equal(readFileSync(join(cwd, 'out.txt'), 'utf8'), 'hi');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('delegate：找不到 agent 類型 → 友善錯誤', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dg2-'));
  try {
    const k = createKernel(createCodingPack({ cwd }), { cwd, model: FAKE_MODEL, getApiKey: () => 'k', streamFn: fakeProvider([textMsg('x')]) });
    assert.match(JSON.stringify(parse(await k.runTool('delegate', { agentType: 'nope', task: 'x' }))), /找不到 agent 類型/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('delegate 註冊存在；spawn 子 agent 工具集不含 delegate（防遞迴）', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dg3-'));
  try {
    const k = createKernel(createCodingPack({ cwd }), { cwd, model: FAKE_MODEL, getApiKey: () => 'k' });
    assert.ok(k.registry.has('delegate'));
    // delegate 非 readOnly → 不在唯讀工具集（spawn 子 agent 不會拿到它）
    assert.ok(!k.registry.readOnlyNames().includes('delegate'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
