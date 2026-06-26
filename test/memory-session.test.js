// 記憶 + session resume 測試。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/kernel/memory.js';
import { newSessionId, saveSession, loadSession, listSessions, latestSession } from '../src/kernel/session.js';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

// ── memory ──
test('memory：save / list / dedup / load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  try {
    const m = createMemory(join(dir, 'memory.md'));
    assert.deepEqual(m.list(), []);
    assert.deepEqual(m.save('使用者偏好繁體中文'), { saved: '使用者偏好繁體中文' });
    assert.deepEqual(m.save('使用者偏好繁體中文'), { skipped: true });  // dedup
    m.save('build 指令是 npm run build');
    assert.equal(m.list().length, 2);
    assert.match(m.load(), /繁體中文/);
    assert.deepEqual(m.save('   '), { error: 'value 不可為空' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('memory：工具自動注入 + 跨 kernel 載入注入 systemPrompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memk-'));
  try {
    const k1 = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    assert.ok(k1.registry.has('memory_save') && k1.registry.has('memory_list'));
    // 透過工具存一條（readOnly → 守衛自動放行）
    const r = await k1.runTool('memory_save', { value: '專案用 pnpm 不是 npm' });
    assert.ok(r.result);
    // 同 cwd+pack 新建 kernel → 記憶被載入 systemPrompt
    const k2 = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    assert.match(k2.systemPrompt, /已記住的事實/);
    assert.match(k2.systemPrompt, /pnpm 不是 npm/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── session ──
test('session：id 格式 YYYYMMDD-HHMMSS', () => {
  assert.match(newSessionId(new Date(2026, 5, 27, 9, 8, 7)), /^20260627-090807$/);
});

test('session：save / load / list / latest 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sess-'));
  try {
    saveSession(dir, 'a', { messages: [{ role: 'user', content: [] }], model: { id: 'M' } });
    saveSession(dir, 'b', { messages: [{ role: 'user', content: [] }, { role: 'assistant', content: [] }] });
    assert.equal(loadSession(dir, 'a').messages.length, 1);
    assert.equal(loadSession(dir, 'nope'), null);
    const ls = listSessions(dir);
    assert.equal(ls.length, 2);
    assert.equal(latestSession(dir).id, 'b'); // b 後存 → 最新
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('session：kernel.session 存檔後可載回 messages（resume 基礎）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessk-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    const id = k.session.newId();
    k.session.save(id, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    const loaded = k.session.load(id);
    assert.equal(loaded.messages[0].content[0].text, 'hi');
    assert.ok(existsSync(join(dir, '.xitto-kernel', 'coding', 'sessions', id + '.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
