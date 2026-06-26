// MCP 接入：無設定/壞設定/連線失敗都優雅略過；extraTools 注入 kernel。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpTools } from '../src/kernel/mcp.js';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

test('無 mcp.json → 空工具', async () => {
  const r = await loadMcpTools('/no/such/mcp.json');
  assert.deepEqual(r.tools, []);
  await r.close();
});

test('壞 JSON → 優雅略過', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  try {
    const p = join(dir, 'mcp.json');
    writeFileSync(p, '{ not json');
    const r = await loadMcpTools(p);
    assert.deepEqual(r.tools, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server 指令不存在 → 略過該 server、不擲錯', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp2-'));
  try {
    const p = join(dir, 'mcp.json');
    writeFileSync(p, JSON.stringify({ mcpServers: { bad: { command: 'this-cmd-does-not-exist-xyz', args: [] } } }));
    const logs = [];
    const r = await loadMcpTools(p, (m) => logs.push(m));
    assert.deepEqual(r.tools, []);
    assert.ok(logs.some((l) => /失敗|略過/.test(l)));
    await r.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extraTools 注入 kernel registry（外部工具 = mutating，走確認/計劃擋）', () => {
  const fake = { name: 'mcp__x__do', label: 'x:do', mutating: true, description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) };
  const k = createKernel(createCodingPack(), { extraTools: [fake] });
  assert.ok(k.registry.has('mcp__x__do'));
  assert.ok([...k.mutatingTools].includes('mcp__x__do'));
});
