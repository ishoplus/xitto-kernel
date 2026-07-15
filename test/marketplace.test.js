// 技能市集/插件（對標 CC plugin marketplace）：多市集、探索 plugin、安裝→技能併入發現層。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketplaces } from '../src/kernel/marketplace.js';
import { createSkills } from '../src/kernel/skills.js';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const call = (tool, args) => tool.execute('t', args || {}).then((r) => JSON.parse(r.content[0].text));

// 造一個「本地市集」：mp/<plugin>/skills/*.md 或 <plugin>/skills/<skill>/SKILL.md
const mkPlugin = (mpDir, plugin, skills) => {
  for (const [name, body] of Object.entries(skills)) {
    const sd = join(mpDir, plugin, 'skills');
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, `${name}.md`), body);
  }
};

test('add(本地) → discover plugins → install → pluginSkillDirs 併入技能', () => {
  const root = tmp('mkt-'); const mp = tmp('mp-');
  try {
    mkPlugin(mp, 'pdf-tools', { extract: '---\ndescription: 抽取 PDF 文字\n---\n# 步驟\n用 pdftotext' });
    mkPlugin(mp, 'qr', { gen: '---\ndescription: 生成 QR code\n---\n# 步驟\nqrencode' });
    const m = createMarketplaces({ root });

    const added = m.add('office', mp);
    assert.equal(added.added, 'office');
    assert.equal(added.git, false);
    assert.deepEqual(added.plugins.sort(), ['pdf-tools', 'qr']);

    // 列出：兩個 plugin，皆未安裝
    const [mkt] = m.list();
    assert.equal(mkt.name, 'office');
    assert.deepEqual(mkt.plugins.map((p) => `${p.name}:${p.installed}`).sort(), ['pdf-tools:false', 'qr:false']);

    // 未安裝 → 不併入
    assert.equal(m.pluginSkillDirs().length, 0);

    // 安裝一個
    const inst = m.install('pdf-tools');
    assert.equal(inst.installed, 'pdf-tools@office');
    assert.equal(inst.skills, 1);
    const dirs = m.pluginSkillDirs();
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0].plugin, 'pdf-tools');

    // 技能發現層：createSkills 併入 → scope=plugin、帶 source
    const skills = createSkills(join(root, 'ws'), { pluginDirs: () => m.pluginSkillDirs() });
    const list = skills.list();
    const extract = list.find((s) => s.name === 'extract');
    assert.ok(extract, '插件技能應出現');
    assert.equal(extract.scope, 'plugin');
    assert.equal(extract.source, 'office/pdf-tools');
    assert.match(skills.promptSection(), /extract：抽取 PDF 文字（插件 office\/pdf-tools）/);
    assert.ok(!list.find((s) => s.name === 'gen'), '未安裝的 qr 插件技能不應出現');

    // uninstall → 立刻不再併入
    m.uninstall('pdf-tools');
    assert.equal(m.pluginSkillDirs().length, 0);
    assert.ok(!skills.reload().find((s) => s.name === 'extract'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(mp, { recursive: true, force: true }); }
});

test('多市集：同名 plugin 需 @market 消歧；<plugin>@<market> 指定安裝', () => {
  const root = tmp('mkt2-'); const a = tmp('mpa-'); const b = tmp('mpb-');
  try {
    mkPlugin(a, 'shared', { x: '---\ndescription: 來自 A\n---\n# a' });
    mkPlugin(b, 'shared', { x: '---\ndescription: 來自 B\n---\n# b' });
    const m = createMarketplaces({ root });
    m.add('mkA', a); m.add('mkB', b);
    assert.equal(m.list().length, 2, '可同時加入多個市集');

    // 不指定市集 → 消歧錯誤
    const ambiguous = m.install('shared');
    assert.match(ambiguous.error, /多個市集有同名/);
    assert.deepEqual(ambiguous.matches.sort(), ['shared@mka', 'shared@mkb']);

    // 指定 @market → 成功
    const inst = m.install('shared@mkB');
    assert.equal(inst.installed, 'shared@mkb');
    const dirs = m.pluginSkillDirs();
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0].marketplace, 'mkb');
  } finally { for (const d of [root, a, b]) rmSync(d, { recursive: true, force: true }); }
});

test('manifest 驅動（相容 .claude-plugin/marketplace.json）', () => {
  const root = tmp('mkt3-'); const mp = tmp('mp3-');
  try {
    mkdirSync(join(mp, '.claude-plugin'), { recursive: true });
    writeFileSync(join(mp, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'writing', source: './packs/writing' }] }));
    const sd = join(mp, 'packs', 'writing', 'skills');
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, 'outline.md'), '---\ndescription: 產出大綱\n---\n# x');
    const m = createMarketplaces({ root });
    const added = m.add('cc', mp);
    assert.deepEqual(added.plugins, ['writing']);
    m.install('writing@cc');
    assert.equal(m.pluginSkillDirs()[0].plugin, 'writing');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(mp, { recursive: true, force: true }); }
});

test('git 來源：注入 gitRunner（不碰網路），clone 進 clonesDir/<name>；update pull；remove 清理', () => {
  const root = tmp('mkt4-');
  try {
    const calls = [];
    // 假 git：clone 時把一個 plugin 寫進目標目錄
    const gitRunner = (args, cwd) => {
      calls.push(args);
      if (args[0] === 'clone') {
        const dest = join(cwd, args[args.length - 1]);
        mkPlugin(dest, 'demo', { hello: '---\ndescription: 打招呼\n---\n# hi' });
        mkdirSync(join(dest, '.git'), { recursive: true });
      }
      return { ok: true, code: 0, output: 'ok' };
    };
    const m = createMarketplaces({ root, gitRunner });
    const added = m.add('remote', 'https://example.com/repo.git');
    assert.equal(added.git, true);
    assert.deepEqual(added.plugins, ['demo']);
    assert.ok(existsSync(join(root, 'marketplaces', 'remote', '.git')));
    assert.equal(calls[0][0], 'clone');

    // 已存在 .git → update 走 pull
    const upd = m.update('remote');
    assert.equal(upd[0].status, 'updated');
    assert.ok(calls.some((a) => a.includes('pull')));

    // remove(purge) → 註冊表與 clone 目錄都清掉
    m.install('demo'); // 順帶驗證安裝也一併被清
    m.remove('remote');
    assert.equal(m.list().length, 0);
    assert.equal(existsSync(join(root, 'marketplaces', 'remote')), false);
    assert.equal(m.pluginSkillDirs().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('市集停用(setEnabled=false) → 其插件技能不併入；onChange 於變更時觸發', () => {
  const root = tmp('mkt5-'); const mp = tmp('mp5-');
  try {
    mkPlugin(mp, 'p', { s: '---\ndescription: d\n---\n# x' });
    let changes = 0;
    const m = createMarketplaces({ root, onChange: () => { changes++; } });
    m.add('mk', mp);      // change
    m.install('p');       // change
    assert.equal(m.pluginSkillDirs().length, 1);
    m.setEnabled('mk', false); // change
    assert.equal(m.pluginSkillDirs().length, 0, '市集停用 → 不併入');
    assert.ok(changes >= 3, 'add/install/setEnabled 皆應觸發 onChange');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(mp, { recursive: true, force: true }); }
});

test('工具面：marketplace_list / plugin_install（readOnly）；marketplace_add（mutating）', async () => {
  const root = tmp('mkt6-'); const mp = tmp('mp6-');
  try {
    mkPlugin(mp, 'toolp', { t: '---\ndescription: d\n---\n# x' });
    const m = createMarketplaces({ root });
    const byName = Object.fromEntries(m.tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ['marketplace_add', 'marketplace_list', 'plugin_install', 'plugin_uninstall']);
    assert.equal(byName.marketplace_add.mutating, true, '加入市集(網路/磁碟) → mutating，走權限步驟');
    assert.equal(byName.marketplace_list.readOnly, true);
    assert.equal(byName.plugin_install.readOnly, true);

    assert.equal((await call(byName.marketplace_add, { name: 'mk', source: mp })).added, 'mk');
    assert.equal((await call(byName.marketplace_list)).marketplaces[0].name, 'mk');
    const inst = await call(byName.plugin_install, { plugin: 'toolp' });
    assert.equal(inst.installed, 'toolp@mk');
    assert.equal((await call(byName.plugin_uninstall, { plugin: 'toolp' })).uninstalled, 'toolp');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(mp, { recursive: true, force: true }); }
});

test('穩健性：不存在的本地來源被拒；install 未知插件回可用清單；讀壞註冊表回空', () => {
  const root = tmp('mkt7-');
  try {
    const m = createMarketplaces({ root });
    assert.match(m.add('x', '/no/such/path/xyz').error, /不存在/);
    assert.match(m.install('nope').error, /找不到此 plugin/);
    // 壞 JSON 註冊表 → 視為空，不崩
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'marketplaces.json'), '{ broken');
    assert.deepEqual(m.list(), []);
    assert.deepEqual(m.pluginSkillDirs(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
