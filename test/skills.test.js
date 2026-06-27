// Skills：漸進揭露（載入、prompt 只列名稱簡述）+ 結晶層（agent 自寫 skill_save + 熱掃描 + 跨 session 列入）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkills } from '../src/kernel/skills.js';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const seed = (dir) => {
  const sd = join(dir, '.xitto-kernel', 'coding', 'skills');
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'deploy.md'), 'description: 部署到正式環境\n\n# 部署步驟\n1. 跑測試\n2. build\n3. push');
  return sd;
};
const call = (tool, args) => tool.execute('t', args).then((r) => JSON.parse(r.content[0].text));

test('createSkills：載入 + desc + promptSection 只列名稱簡述', () => {
  const dir = tmp('sk-');
  try {
    const s = createSkills(seed(dir));
    assert.equal(s.skills.length, 1);
    assert.equal(s.skills[0].name, 'deploy');
    assert.equal(s.skills[0].desc, '部署到正式環境');
    assert.match(s.promptSection(), /deploy：部署到正式環境/);
    assert.doesNotMatch(s.promptSection(), /跑測試/);   // 漸進揭露：prompt 不含全文
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('無 skills 目錄 → skill/skill_save 仍在；promptSection 引導結晶', () => {
  const dir = tmp('sk0-');
  try {
    const s = createSkills(join(dir, 'nope'));
    assert.equal(s.tools.length, 2);                    // skill + skill_save 永遠在（才能結晶第一個）
    assert.equal(s.skills.length, 0);
    assert.match(s.promptSection(), /skill_save/);      // 引導：可結晶
    assert.doesNotMatch(s.promptSection(), /可用技能/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('整合：skill 工具載入全文 + 注入 prompt', async () => {
  const dir = tmp('skk-');
  try {
    seed(dir);
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    assert.ok(k.registry.has('skill'));
    assert.match(k.systemPrompt, /可用技能/);
    const r = await k.runTool('skill', { name: 'deploy' });
    assert.match(r.result.content[0].text, /跑測試/);   // 載入全文
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('結晶：skill_save 寫檔（frontmatter）+ skill 熱掃描即時載入', async () => {
  const dir = tmp('skc-');
  try {
    const sk = createSkills(dir);
    const [load, save] = sk.tools;
    assert.equal((await call(save, { name: '發布流程', description: '版本發布 SOP', body: '1. bump\n2. npm test\n3. tag + push' })).saved, '發布流程');
    assert.ok(existsSync(join(dir, '發布流程.md')));
    assert.match(readFileSync(join(dir, '發布流程.md'), 'utf8'), /---\ndescription: 版本發布 SOP\n---/);
    const raw = await load.execute('t', { name: '發布流程' });   // 同實例熱掃描找得到
    assert.match(raw.content[0].text, /tag \+ push/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('結晶：未知名回 available；slug 防穿越；空 body 防呆；同名 updated；remove', async () => {
  const dir = tmp('skv-');
  try {
    const sk = createSkills(dir);
    const save = sk.tools[1];
    await call(save, { name: 'a', body: 'x' });
    assert.deepEqual((await call(sk.tool, { name: '無' })).available, ['a']);
    const slugged = await call(save, { name: '../../evil!!', body: 'ok' });
    assert.ok(slugged.saved && !/[/.]/.test(slugged.saved));
    assert.equal((await call(save, { name: 'x', body: '  ' })).error, 'body 不可為空');
    assert.ok((await call(save, { name: 'a', body: 'v2' })).updated);
    assert.deepEqual(sk.remove('a'), { removed: 'a' });
    assert.equal(existsSync(join(dir, 'a.md')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kernel：skill_save 注入 + 自寫技能跨 session 列入 prompt', async () => {
  const cwd = tmp('ski-');
  try {
    const model = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k' });
    assert.ok(k.registry.has('skill') && k.registry.has('skill_save'));
    await k.registry.get('skill_save').execute('t', { name: 'release', description: '發版 SOP', body: 'bump→test→tag' });
    assert.deepEqual(k.skills.list(), [{ name: 'release', desc: '發版 SOP' }]);
    const k2 = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k' });
    assert.match(k2.systemPrompt, /release：發版 SOP/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
