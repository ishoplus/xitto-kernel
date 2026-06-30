// ④ 可執行技能：skill_save 可附 script → skill_run 確定性重跑（免 LLM），經安全檢查/沙箱。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const parse = (r) => JSON.parse(r.result.content[0].text);

test('skill_save 附 script → 標記 executable；skill_run 確定性重跑', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sk-'));
  try {
    const k = createKernel(createCodingPack({ cwd }), { cwd });
    const saved = parse(await k.runTool('skill_save', {
      name: 'mk-stamp', goal: '建立 stamp.txt', body: '步驟：寫入 stamp 檔',
      verify: 'true', script: 'echo stamped > stamp.txt',
    }));
    assert.ok(saved.saved || saved.updated, '應結晶成功');
    assert.equal(saved.executable, true, '應標記為可執行');

    const ran = parse(await k.runTool('skill_run', { name: 'mk-stamp' }));
    assert.equal(ran.ran, 'mk-stamp');
    assert.equal(ran.ok, true);
    assert.ok(existsSync(join(cwd, 'stamp.txt')), '腳本應真的執行（產生 stamp.txt）');
    assert.match(readFileSync(join(cwd, 'stamp.txt'), 'utf8'), /stamped/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('skill_run：技能無腳本 → 友善錯誤', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sk2-'));
  try {
    const k = createKernel(createCodingPack({ cwd }), { cwd });
    await k.runTool('skill_save', { name: 'no-script', goal: 'x', body: '只有步驟', verify: 'true' }); // 不附 script
    const r = parse(await k.runTool('skill_run', { name: 'no-script' }));
    assert.match(JSON.stringify(r), /沒有可執行腳本/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('skill_run：危險腳本 → 被安全策略擋下（不執行）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sk3-'));
  try {
    const k = createKernel(createCodingPack({ cwd }), { cwd });
    // verify 用 true 通過存檔；script 為危險指令
    await k.runTool('skill_save', { name: 'danger', goal: 'x', body: 'y', verify: 'true', script: 'rm -rf /' });
    const r = parse(await k.runTool('skill_run', { name: 'danger' }));
    assert.match(JSON.stringify(r), /安全策略擋下|危險/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('skill_run：找不到技能 → 友善錯誤', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sk4-'));
  try {
    const k = createKernel(createCodingPack({ cwd }), { cwd });
    const r = parse(await k.runTool('skill_run', { name: '不存在' }));
    assert.match(JSON.stringify(r), /找不到技能/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
