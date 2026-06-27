// Skills：漸進揭露（載入、prompt 只列名稱簡述）+ 結晶層（自寫 skill_save，須有 goal + 通過 verify 才新增）。
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
// 假驗證器：含 danger→擋；含 fail→未過；否則通過
const fakeRunner = async (cmd) => (/danger/.test(cmd) ? { ok: false, blocked: true, reason: '危險' }
  : /fail/.test(cmd) ? { ok: false, code: 1, output: 'boom' } : { ok: true, code: 0, output: 'ok' });
const mk = (dir) => createSkills(dir, { verifyRunner: fakeRunner });

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
    assert.deepEqual(s.tools.map((t) => t.name), ['skill', 'skill_save', 'skills_check']); // 永遠在
    assert.match(s.promptSection(), /skill_save/);
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
    assert.match(r.result.content[0].text, /跑測試/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('結晶：goal + 通過 verify → 寫檔（含 goal/verified frontmatter + 驗證區塊）', async () => {
  const dir = tmp('skc-');
  try {
    const sk = mk(dir);
    const [load, save] = sk.tools;
    const r = await call(save, { name: '發布流程', goal: '一鍵發版到 npm', body: '1. bump\n2. npm test\n3. tag', verify: 'npm test' });
    assert.equal(r.saved, '發布流程');
    assert.equal(r.verified, true);
    const md = readFileSync(join(dir, '發布流程.md'), 'utf8');
    assert.match(md, /verified: true/);
    assert.match(md, /goal: 一鍵發版到 npm/);
    assert.match(md, /## 目標\n一鍵發版到 npm/);
    assert.match(md, /## 驗證（已通過 exit 0）/);
    const raw = await load.execute('t', { name: '發布流程' });   // 熱掃描可載
    assert.match(raw.content[0].text, /npm test/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('政策閘門：缺 goal / 缺 verify / verify 未過 / verify 被擋 → 都不新增', async () => {
  const dir = tmp('skg-');
  try {
    const save = mk(dir).tools[1];
    assert.match((await call(save, { name: 'a', body: 'b', verify: 'ok' })).error, /缺 goal/);
    assert.match((await call(save, { name: 'a', goal: 'g', body: 'b' })).error, /缺 verify/);
    const failed = await call(save, { name: 'bad', goal: 'g', body: 'b', verify: 'run fail' });
    assert.match(failed.error, /驗證未通過/);
    assert.equal(failed.exitCode, 1);
    assert.equal(existsSync(join(dir, 'bad.md')), false, '未過不得落地');
    const blocked = await call(save, { name: 'dang', goal: 'g', body: 'b', verify: 'danger rm -rf /' });
    assert.match(blocked.error, /安全策略擋下/);
    assert.equal(existsSync(join(dir, 'dang.md')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('結晶：無 verifyRunner 環境 → 拒絕新增；slug 防穿越；同名 updated', async () => {
  const dir = tmp('skv-');
  try {
    assert.match((await call(createSkills(dir).tools[1], { name: 'x', goal: 'g', body: 'b', verify: 'ok' })).error, /不支援技能驗證/);
    const save = mk(dir).tools[1];
    const slugged = await call(save, { name: '../../evil!!', goal: 'g', body: 'ok', verify: 'ok' });
    assert.ok(slugged.saved && !/[/.]/.test(slugged.saved));
    assert.ok((await call(save, { name: 'dep', goal: 'g', body: 'v1', verify: 'ok' })).saved);
    assert.ok((await call(save, { name: 'dep', goal: 'g', body: 'v2', verify: 'ok' })).updated);
    assert.match(readFileSync(join(dir, 'dep.md'), 'utf8'), /v2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('使用戳記（A）：skill 載入 → usedCount 累加 + lastUsedAt', async () => {
  const dir = tmp('sku-');
  try {
    const sk = mk(dir);
    const [load, save] = sk.tools;
    await call(save, { name: 'a', goal: 'g', body: 'b', verify: 'ok' });
    assert.equal(sk.list().find((s) => s.name === 'a').used, 0);
    await load.execute('t', { name: 'a' });
    await load.execute('t', { name: 'a' });
    const s = sk.list().find((x) => x.name === 'a');
    assert.equal(s.used, 2);
    assert.match(readFileSync(join(dir, 'a.md'), 'utf8'), /lastUsedAt:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('漂移偵測（B）：check 重跑 verify → 標 ok / stale', async () => {
  const dir = tmp('skd-');
  try {
    let failNow = false;
    const runner = async (cmd) => (/danger/.test(cmd) ? { ok: false, blocked: true, reason: 'x' } : (failNow ? { ok: false, code: 1, output: 'drift' } : { ok: true, code: 0, output: 'ok' }));
    const sk = createSkills(dir, { verifyRunner: runner });
    await sk.tools[1].execute('t', { name: 'a', goal: 'g', body: 'b', verify: 'check-cmd' }); // 建立時通過
    // 仍有效
    let res = await sk.check();
    assert.equal(res.find((r) => r.name === 'a').status, 'ok');
    assert.equal(sk.list().find((s) => s.name === 'a').stale, false);
    // 專案變動 → verify 失效
    failNow = true;
    res = await sk.check();
    assert.equal(res.find((r) => r.name === 'a').status, 'stale');
    assert.equal(sk.list().find((s) => s.name === 'a').stale, true);
    assert.match(sk.promptSection(), /a：.*已失效待修/);
    // 修好 → check 回 ok,stale 清除
    failNow = false;
    await sk.check();
    assert.equal(sk.list().find((s) => s.name === 'a').stale, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('漂移偵測：無 verify 區塊的技能 → no-verify（不誤判 stale）', async () => {
  const dir = tmp('skn-');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manual.md'), 'description: 純思考型\n\n# 檢查清單\n- a\n- b');
    const sk = mk(dir);
    const res = await sk.check();
    assert.equal(res.find((r) => r.name === 'manual').status, 'no-verify');
    assert.equal(sk.list().find((s) => s.name === 'manual').stale, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kernel：真實 runVerify — verify 通過(true)才新增，失敗(false)拒絕；api.skills.check 可用', async () => {
  const cwd = tmp('ski-');
  try {
    const model = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k' });
    assert.ok(k.registry.has('skill') && k.registry.has('skill_save') && k.registry.has('skills_check'));
    const save = k.registry.get('skill_save');
    // 真實在沙箱外跑 `true` → exit 0 → 新增
    const ok = JSON.parse((await save.execute('t', { name: 'release', goal: '發版 SOP', body: 'bump→test→tag', verify: 'true' })).content[0].text);
    assert.equal(ok.saved, 'release');
    assert.deepEqual(k.skills.list(), [{ name: 'release', desc: '發版 SOP', used: 0, stale: false }]);
    // `false` → exit 1 → 拒絕
    const bad = JSON.parse((await save.execute('t', { name: 'nope', goal: 'g', body: 'b', verify: 'false' })).content[0].text);
    assert.match(bad.error, /驗證未通過/);
    // api.skills.check：release 的 verify 是 `true` → 仍 ok
    const checked = await k.skills.check();
    assert.equal(checked.find((r) => r.name === 'release').status, 'ok');
    // 新 session：已驗證技能列入 prompt
    const k2 = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k' });
    assert.match(k2.systemPrompt, /release：發版 SOP/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
