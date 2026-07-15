// 技能市集與插件（對標 Claude Code plugin marketplace）——多市集、可安裝插件、技能併入發現層。
// 市集＝一個 git 倉庫或本地目錄，內含若干 plugin；plugin＝帶 skills/ 的單位（子目錄或市集本身）。
// 註冊表存 <root>/marketplaces.json（root＝XITTO_SKILLS_DIR||~/.xitto-code，跨 pack 共用）。
//   { marketplaces: { <name>: { source, git, enabled, addedAt } }, installed: [ { marketplace, plugin } ] }
// 流程：marketplace_add（git 則 clone）→ marketplace_list 看有哪些 plugin → plugin_install 啟用 →
//        該 plugin 的 skills 併入 createSkills 的發現層（多市集合併，scope='plugin'）。人在迴路：
//        add/update 為 mutating（網路），走 kernel 權限步驟；install/uninstall 僅改本地註冊表。
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

// 市集/插件根目錄（與全域技能同根，跨 pack 共用）；可用 XITTO_SKILLS_DIR 覆寫。
export const marketplaceRoot = () => process.env.XITTO_SKILLS_DIR || join(homedir(), '.xitto-code');

const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });
const nowIso = () => new Date().toISOString();
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const isGitSource = (s) => /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(String(s || '')) || /\.git\/?$/.test(String(s || ''));

// 真實 git（clone/pull）；args 為陣列 → 無 shell 注入。測試可注入 gitRunner 避開網路。
function defaultGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const output = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 4000);
  if (r.error) return { ok: false, code: null, output: (output + ' ' + r.error.message).trim() };
  return { ok: r.status === 0, code: r.status, output: output || '(no output)' };
}

export function createMarketplaces({ root = marketplaceRoot(), gitRunner = defaultGit, onChange } = {}) {
  const regFile = join(root, 'marketplaces.json');
  const clonesDir = join(root, 'marketplaces');

  const readReg = () => {
    try {
      const j = JSON.parse(readFileSync(regFile, 'utf8'));
      return {
        marketplaces: (j && typeof j.marketplaces === 'object' && j.marketplaces) || {},
        installed: Array.isArray(j?.installed) ? j.installed : [],
      };
    } catch { return { marketplaces: {}, installed: [] }; }
  };
  const writeReg = (reg) => { mkdirSync(root, { recursive: true }); writeFileSync(regFile, JSON.stringify(reg, null, 2)); };
  const changed = () => { try { if (typeof onChange === 'function') onChange(); } catch { /* 略 */ } };

  // 市集本地路徑：git 來源 → clonesDir/<name>；本地路徑來源 → 解析為絕對路徑。
  const localPath = (name, entry) => (entry.git ? join(clonesDir, name) : resolve(entry.source));

  // 讀市集 manifest（相容 CC 的 .claude-plugin/marketplace.json；也支援 marketplace.json / xitto-plugins.json）。
  const readManifest = (mpPath) => {
    for (const rel of ['.claude-plugin/marketplace.json', 'marketplace.json', 'xitto-plugins.json']) {
      const f = join(mpPath, rel);
      if (!existsSync(f)) continue;
      try { const j = JSON.parse(readFileSync(f, 'utf8')); if (Array.isArray(j?.plugins)) return j; } catch { /* 略 */ }
    }
    return null;
  };

  // 探索市集內的 plugin（每個帶 skills/ 的單位）。manifest 優先；否則自動偵測：
  // 市集根本身帶 skills/ → 視為單一 plugin（_root）；否則掃子目錄，任何含 skills/ 者為一個 plugin。
  const discoverPlugins = (mpPath) => {
    if (!mpPath || !existsSync(mpPath)) return [];
    const out = [];
    const seen = new Set();
    const push = (name, dir) => {
      const n = slug(name);
      if (!n || seen.has(n) || !existsSync(join(dir, 'skills'))) return;
      seen.add(n); out.push({ name: n, skillsDir: join(dir, 'skills') });
    };
    const manifest = readManifest(mpPath);
    if (manifest) {
      for (const p of manifest.plugins) {
        const relDir = String(p.source || p.path || p.name || '').replace(/^\.\/?/, '');
        push(p.name || relDir, join(mpPath, relDir));
      }
      return out;
    }
    if (existsSync(join(mpPath, 'skills'))) return [{ name: '_root', skillsDir: join(mpPath, 'skills') }];
    for (const e of readdirSync(mpPath, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('.'))) {
      push(e.name, join(mpPath, e.name));
    }
    return out;
  };

  const countSkills = (dir) => {
    try {
      let n = readdirSync(dir).filter((f) => f.endsWith('.md')).length;
      for (const e of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory())) if (existsSync(join(dir, e.name, 'SKILL.md'))) n++;
      return n;
    } catch { return 0; }
  };

  const pluginsOf = (name) => {
    const reg = readReg();
    const entry = reg.marketplaces[slug(name)];
    return entry ? discoverPlugins(localPath(slug(name), entry)) : [];
  };

  const list = () => {
    const reg = readReg();
    const installedSet = new Set(reg.installed.map((i) => `${i.marketplace}/${i.plugin}`));
    return Object.entries(reg.marketplaces).map(([name, entry]) => {
      const path = localPath(name, entry);
      const present = existsSync(path);
      const plugins = present ? discoverPlugins(path).map((p) => ({ name: p.name, installed: installedSet.has(`${name}/${p.name}`) })) : [];
      return { name, source: entry.source, git: !!entry.git, enabled: entry.enabled !== false, present, plugins };
    });
  };

  const add = (name, source, { enabled = true } = {}) => {
    const nm = slug(name);
    if (!nm) return { error: 'name 不合法（需含英數）' };
    if (!source || !String(source).trim()) return { error: '缺 source（git URL 或本地路徑）' };
    const git = isGitSource(source);
    const reg = readReg();
    if (git) {
      mkdirSync(clonesDir, { recursive: true });
      const dest = join(clonesDir, nm);
      const g = existsSync(join(dest, '.git'))
        ? gitRunner(['-C', dest, 'pull', '--ff-only'], clonesDir)
        : gitRunner(['clone', '--depth', '1', String(source), nm], clonesDir);
      if (!g.ok) return { error: 'git 取得市集失敗', output: g.output, source: String(source) };
    } else if (!existsSync(resolve(source))) {
      return { error: '本地市集路徑不存在', path: resolve(source) };
    }
    reg.marketplaces[nm] = { source: String(source), git, enabled, addedAt: nowIso() };
    writeReg(reg);
    changed();
    const plugins = pluginsOf(nm).map((p) => p.name);
    return { added: nm, git, source: String(source), plugins, hint: plugins.length ? `發現 ${plugins.length} 個 plugin，用 plugin_install <plugin>@${nm} 安裝` : '此市集未發現含 skills/ 的 plugin' };
  };

  const remove = (name, { purge = true } = {}) => {
    const nm = slug(name);
    const reg = readReg();
    const entry = reg.marketplaces[nm];
    if (!entry) return { error: '找不到市集', name: nm };
    delete reg.marketplaces[nm];
    reg.installed = reg.installed.filter((i) => i.marketplace !== nm);
    writeReg(reg);
    if (purge && entry.git) { try { rmSync(join(clonesDir, nm), { recursive: true, force: true }); } catch { /* 略 */ } }
    changed();
    return { removed: nm };
  };

  const update = (name) => {
    const reg = readReg();
    const names = name ? [slug(name)] : Object.keys(reg.marketplaces);
    const results = [];
    for (const nm of names) {
      const entry = reg.marketplaces[nm];
      if (!entry) { results.push({ name: nm, status: 'not-found' }); continue; }
      if (!entry.git) { results.push({ name: nm, status: 'local' }); continue; }
      const dest = join(clonesDir, nm);
      mkdirSync(clonesDir, { recursive: true });
      const g = existsSync(join(dest, '.git'))
        ? gitRunner(['-C', dest, 'pull', '--ff-only'], clonesDir)
        : gitRunner(['clone', '--depth', '1', String(entry.source), nm], clonesDir);
      results.push(g.ok ? { name: nm, status: 'updated' } : { name: nm, status: 'failed', output: g.output });
    }
    changed();
    return results;
  };

  const resolveRef = (ref) => {
    const s = String(ref || '').trim();
    const at = s.lastIndexOf('@');
    if (at > 0) return { plugin: slug(s.slice(0, at)), marketplace: slug(s.slice(at + 1)) };
    return { plugin: slug(s), marketplace: null };
  };

  // 找出某 plugin 存在於哪些市集（未指定市集時掃全部）；用於安裝消歧。
  const findPlugin = ({ plugin, marketplace }) => {
    const reg = readReg();
    const markets = marketplace ? [marketplace] : Object.keys(reg.marketplaces);
    return markets.filter((m) => reg.marketplaces[m] && discoverPlugins(localPath(m, reg.marketplaces[m])).some((p) => p.name === plugin));
  };

  const install = (ref) => {
    const parsed = resolveRef(ref);
    if (!parsed.plugin) return { error: 'plugin ref 不合法（用 <plugin> 或 <plugin>@<market>）' };
    const reg = readReg();
    if (parsed.marketplace && !reg.marketplaces[parsed.marketplace]) return { error: '找不到市集', marketplace: parsed.marketplace };
    const matches = findPlugin(parsed);
    if (!matches.length) return { error: '在市集中找不到此 plugin', ref: String(ref), available: list().flatMap((m) => m.plugins.map((p) => `${p.name}@${m.name}`)) };
    if (matches.length > 1) return { error: '多個市集有同名 plugin，請用 <plugin>@<market> 指定', matches: matches.map((m) => `${parsed.plugin}@${m}`) };
    const marketplace = matches[0];
    if (reg.installed.some((i) => i.marketplace === marketplace && i.plugin === parsed.plugin)) return { alreadyInstalled: `${parsed.plugin}@${marketplace}` };
    reg.installed.push({ marketplace, plugin: parsed.plugin, installedAt: nowIso() });
    writeReg(reg);
    changed();
    const p = discoverPlugins(localPath(marketplace, reg.marketplaces[marketplace])).find((x) => x.name === parsed.plugin);
    return { installed: `${parsed.plugin}@${marketplace}`, skills: p ? countSkills(p.skillsDir) : 0 };
  };

  const uninstall = (ref) => {
    const parsed = resolveRef(ref);
    const reg = readReg();
    const before = reg.installed.length;
    reg.installed = reg.installed.filter((i) => !(i.plugin === parsed.plugin && (!parsed.marketplace || i.marketplace === parsed.marketplace)));
    if (reg.installed.length === before) return { error: '此 plugin 未安裝', ref: String(ref) };
    writeReg(reg);
    changed();
    return { uninstalled: parsed.marketplace ? `${parsed.plugin}@${parsed.marketplace}` : parsed.plugin };
  };

  const setEnabled = (name, enabled) => {
    const nm = slug(name);
    const reg = readReg();
    if (!reg.marketplaces[nm]) return { error: '找不到市集', name: nm };
    reg.marketplaces[nm].enabled = !!enabled;
    writeReg(reg);
    changed();
    return { name: nm, enabled: !!enabled };
  };

  // 供 createSkills 併入發現層：回傳每個「已安裝且市集啟用」plugin 的 skills 目錄 + 出處。
  const pluginSkillDirs = () => {
    const reg = readReg();
    const dirs = [];
    for (const inst of reg.installed) {
      const entry = reg.marketplaces[inst.marketplace];
      if (!entry || entry.enabled === false) continue;
      const p = discoverPlugins(localPath(inst.marketplace, entry)).find((x) => x.name === inst.plugin);
      if (p && existsSync(p.skillsDir)) dirs.push({ dir: p.skillsDir, marketplace: inst.marketplace, plugin: inst.plugin });
    }
    return dirs;
  };

  const addTool = {
    name: 'marketplace_add', label: '加入技能市集', mutating: true,
    description: '加入一個技能市集（對標 Claude Code plugin marketplace）。source 可為 git URL（會 clone）或本地目錄路徑。加入後用 marketplace_list 看它提供哪些 plugin，再用 plugin_install 安裝。可同時加入多個市集（官方＋私有＋本地），安裝時用 <plugin>@<market> 消歧。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '市集短名（自取，用來消歧）' }, source: { type: 'string', description: 'git URL 或本地目錄路徑' } }, required: ['name', 'source'] },
    execute: async (_id, { name, source }) => txt(add(name, source)),
  };
  const listTool = {
    name: 'marketplace_list', label: '列出市集/插件', readOnly: true,
    description: '列出所有已加入的技能市集、各自提供的 plugin，以及哪些已安裝。',
    parameters: { type: 'object', properties: {} },
    execute: async () => txt({ marketplaces: list() }),
  };
  const installTool = {
    name: 'plugin_install', label: '安裝插件', readOnly: true,
    description: '安裝某市集的一個 plugin，其技能即併入你的可用技能（下次用 skill 按名載入可見）。plugin 用 <plugin> 或 <plugin>@<market>（多市集同名時須加 @market 消歧）。',
    parameters: { type: 'object', properties: { plugin: { type: 'string', description: 'plugin 名，或 <plugin>@<market>' } }, required: ['plugin'] },
    execute: async (_id, { plugin }) => txt(install(plugin)),
  };
  const uninstallTool = {
    name: 'plugin_uninstall', label: '移除插件', readOnly: true,
    description: '移除已安裝的 plugin（其技能不再併入）。plugin 用 <plugin> 或 <plugin>@<market>。',
    parameters: { type: 'object', properties: { plugin: { type: 'string', description: 'plugin 名，或 <plugin>@<market>' } }, required: ['plugin'] },
    execute: async (_id, { plugin }) => txt(uninstall(plugin)),
  };

  return {
    tools: [listTool, addTool, installTool, uninstallTool],
    list, add, remove, update, install, uninstall, setEnabled, pluginSkillDirs, plugins: pluginsOf,
    regFile, clonesDir,
  };
}
