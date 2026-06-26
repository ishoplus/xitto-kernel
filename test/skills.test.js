// Skills 漸進揭露：載入、prompt 只列名稱+簡述、skill 工具載全文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkills } from '../src/kernel/skills.js';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const seed = (dir) => {
  const sd = join(dir, '.xitto-kernel', 'coding', 'skills');
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'deploy.md'), 'description: 部署到正式環境\n\n# 部署步驟\n1. 跑測試\n2. build\n3. push');
  return sd;
};

test('createSkills：載入 + desc + promptSection 只列名稱簡述', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sk-'));
  try {
    const s = createSkills(seed(dir));
    assert.equal(s.skills.length, 1);
    assert.equal(s.skills[0].name, 'deploy');
    assert.equal(s.skills[0].desc, '部署到正式環境');
    assert.match(s.promptSection(), /deploy：部署到正式環境/);
    assert.doesNotMatch(s.promptSection(), /跑測試/);   // 漸進揭露：prompt 不含全文
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('無 skills 目錄 → 無 tool、無 promptSection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sk0-'));
  try {
    const s = createSkills(join(dir, 'nope'));
    assert.equal(s.tool, null);
    assert.equal(s.promptSection(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('整合：skill 工具載入全文 + 注入 prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skk-'));
  try {
    seed(dir);
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    assert.ok(k.registry.has('skill'));
    assert.match(k.systemPrompt, /可用技能/);
    const r = await k.runTool('skill', { name: 'deploy' });
    assert.match(r.result.content[0].text, /跑測試/);   // 載入全文
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
