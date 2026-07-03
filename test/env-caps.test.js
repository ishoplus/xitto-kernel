// 環境能力門控 — 證明 requires/env 不滿足的工具/技能對模型不可見，且環境說明注入 prompt。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';

// 最小 pack：一個全環境工具 + 一個需要 hostFs 的工具 + 一個標 env:'local' 的工具。
function makePack() {
  const t = (name, extra = {}) => ({ name, readOnly: true, description: name, parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }), ...extra });
  return {
    name: 'envtest',
    systemPrompt: '測試 pack。',
    tools: () => [t('ls'), t('browse_host', { requires: ['hostFs'] }), t('pick_folder', { env: 'local' })],
  };
}

test('雲端 caps：requires:hostFs 與 env:local 的工具被剔除，全環境工具保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcaps-'));
  try {
    const k = createKernel(makePack(), { cwd: dir, env: 'cloud', caps: ['workspaceFs', 'shell', 'network'], envNote: '雲端邊界說明' });
    assert.ok(k.registry.has('ls'), 'workspaceFs 工具應保留');
    assert.ok(!k.registry.has('browse_host'), '缺 hostFs → 應剔除');
    assert.ok(!k.registry.has('pick_folder'), 'env:local 在 cloud → 應剔除');
    assert.deepEqual(k.env.droppedTools.sort(), ['browse_host', 'pick_folder']);
    assert.match(k.systemPrompt, /運行環境/);
    assert.match(k.systemPrompt, /雲端邊界說明/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('本機 caps：hostFs 具備 + env=local → 工具全數保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcaps-'));
  try {
    const k = createKernel(makePack(), { cwd: dir, env: 'local', caps: ['workspaceFs', 'hostFs', 'shell', 'network'] });
    for (const n of ['ls', 'browse_host', 'pick_folder']) assert.ok(k.registry.has(n), `${n} 應保留`);
    assert.equal(k.env.droppedTools.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('未提供 caps/env（本機 CLI）→ 不門控，向後相容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcaps-'));
  try {
    const k = createKernel(makePack(), { cwd: dir });
    for (const n of ['ls', 'browse_host', 'pick_folder']) assert.ok(k.registry.has(n), `${n} 應保留`);
    assert.match(k.systemPrompt, /測試 pack/);
    assert.doesNotMatch(k.systemPrompt, /運行環境/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('技能按環境隱藏：env:local 的技能在 cloud 不列出、cloud 可列出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcaps-'));
  try {
    const skillsDir = join(dir, '.xitto-kernel', 'envtest', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'browse-local.md'), '---\ndescription: 瀏覽本機資料夾\nenv: local\n---\n\n步驟…');
    writeFileSync(join(skillsDir, 'anywhere.md'), '---\ndescription: 通用技能\n---\n\n步驟…');

    const cloud = createKernel(makePack(), { cwd: dir, env: 'cloud', caps: ['workspaceFs'] });
    const cloudNames = cloud.skills.list().map((s) => s.name);
    assert.ok(cloudNames.includes('anywhere'), '通用技能雲端應可見');
    assert.ok(!cloudNames.includes('browse-local'), 'env:local 技能雲端應隱藏');
    assert.doesNotMatch(cloud.systemPrompt, /瀏覽本機資料夾/);

    const localK = createKernel(makePack(), { cwd: dir, env: 'local', caps: ['workspaceFs', 'hostFs'] });
    const localNames = localK.skills.list().map((s) => s.name);
    assert.ok(localNames.includes('browse-local') && localNames.includes('anywhere'), '本機兩技能皆可見');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
