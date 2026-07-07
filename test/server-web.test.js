// 許願台網頁 + 交付檔案端點：UI 服務（token 注入）、resolveArtifact 防穿越。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApp, resolveArtifact, listWorkspaceFiles, listDir, safeWs, workspaceDir, readWorkspaceExperience } from '../src/app/server.js';

test('resolveArtifact：合法相對路徑 → 解析；穿越/絕對路徑 → null', () => {
  assert.equal(resolveArtifact('/base/s1', 'a.txt'), '/base/s1/a.txt');
  assert.equal(resolveArtifact('/base/s1', 'sub/b.txt'), '/base/s1/sub/b.txt');
  assert.equal(resolveArtifact('/base/s1', '../../etc/passwd'), null);
  assert.equal(resolveArtifact('/base/s1', '/etc/passwd'), null);
  assert.equal(resolveArtifact('/base/s1', ''), null);
  assert.equal(resolveArtifact('/base/s1', null), null);
});

test('safeWs：消毒 workspace 名稱（防穿越）', () => {
  assert.equal(safeWs('essay'), 'essay');
  assert.equal(safeWs('../../etc'), 'etc');
  assert.equal(safeWs(''), 'default');
  assert.equal(safeWs('a b/c'), 'abc');
});

test('workspaceDir：本地+絕對路徑→就地；託管收絕對路徑→消毒不逃逸；相對名→管理空間', () => {
  // 本地模式 + 絕對路徑 → 就地（像 Claude Code 改你選的真實資料夾）
  assert.equal(workspaceDir('/base', '/real/folder', true), '/real/folder');
  // 託管模式收到絕對路徑 → 消毒成管理空間,不逃逸到主機
  assert.equal(workspaceDir('/base', '/real/folder', false), join('/base', 'ws', 'realfolder'));
  // 本地 + 相對名 → 仍是管理空間
  assert.equal(workspaceDir('/base', 'essay', true), join('/base', 'ws', 'essay'));
  // 預設
  assert.equal(workspaceDir('/base', '', false), join('/base', 'ws', 'default'));
});

test('listWorkspaceFiles：列檔（遞迴）+ 排除內部目錄', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xk-wb-'));
  try {
    writeFileSync(join(dir, 'report.md'), '# r');
    mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'a.txt'), 'x');
    mkdirSync(join(dir, '.xitto-kernel')); writeFileSync(join(dir, '.xitto-kernel', 'memory.md'), 'm'); // 內部,不列
    mkdirSync(join(dir, 'tmp')); writeFileSync(join(dir, 'tmp', 'scratch'), 's');                       // 過程,不列
    const files = listWorkspaceFiles(dir).map((f) => f.path).sort();
    assert.deepEqual(files, ['report.md', 'sub/a.txt']);
    assert.ok(listWorkspaceFiles(dir).every((f) => typeof f.size === 'number' && typeof f.mtime === 'number'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listDir：逐層列（不遞迴）+ 子目錄分開 + 排除內部 + 防穿越', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xk-ld-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'x');
    mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'b.txt'), 'y');
    mkdirSync(join(dir, '.xitto-kernel')); mkdirSync(join(dir, 'node_modules'));
    const root = listDir(dir, '');
    assert.deepEqual(root.dirs, ['sub']);                       // 排除 .xitto-kernel / node_modules
    assert.deepEqual(root.files.map((f) => f.name), ['a.txt']); // 不含 sub/b.txt（不遞迴攤平）
    assert.equal(root.sub, '');
    const sub = listDir(dir, 'sub');
    assert.deepEqual(sub.files.map((f) => f.name), ['b.txt']);
    assert.equal(sub.sub, 'sub');
    assert.equal(listDir(dir, '../../etc'), null);              // 防穿越
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GET /v1/fs：本地模式列子資料夾；託管模式 403', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xk-fs-'));
  mkdirSync(join(root, 'projA')); mkdirSync(join(root, 'projB')); mkdirSync(join(root, '.hidden')); mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'file.txt'), 'x');
  const local = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', local: true, baseDir: join(root, '.srv') });
  const hosted = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', local: false, baseDir: join(root, '.srv2') });
  await new Promise((r) => local.listen(0, r)); await new Promise((r) => hosted.listen(0, r));
  try {
    const r = await fetch(`http://localhost:${local.address().port}/v1/fs?path=${encodeURIComponent(root)}`, { headers: { authorization: 'Bearer t' } }).then((x) => x.json());
    assert.deepEqual(r.dirs, ['projA', 'projB']);   // 只列目錄,排除 .hidden / node_modules / 檔案
    assert.equal(r.path, root);
    const rh = await fetch(`http://localhost:${local.address().port}/v1/fs?path=${encodeURIComponent(root)}&hidden=1`, { headers: { authorization: 'Bearer t' } }).then((x) => x.json());
    assert.ok(rh.dirs.includes('.hidden'));        // hidden=1 顯示隱藏資料夾
    assert.ok(!rh.dirs.includes('node_modules'));  // node_modules 仍一律排除
    const f = await fetch(`http://localhost:${hosted.address().port}/v1/fs?path=${encodeURIComponent(root)}`, { headers: { authorization: 'Bearer t' } });
    assert.equal(f.status, 403);                    // 託管模式不給瀏覽主機
  } finally { await new Promise((r) => local.close(r)); await new Promise((r) => hosted.close(r)); rmSync(root, { recursive: true, force: true }); }
});

test('readWorkspaceExperience：跨 pack 聚合五層 + 記憶去重 + 情節新→舊排序', () => {
  const ws = mkdtempSync(join(tmpdir(), 'xk-exp-'));
  try {
    // 空 workspace → 全零
    const empty = readWorkspaceExperience(ws);
    assert.deepEqual(empty.counts, { memory: 0, playbook: 0, skills: 0, episodes: 0, trust: 0 });

    const g = join(ws, '.xitto-kernel', 'general');
    const c = join(ws, '.xitto-kernel', 'coding');
    mkdirSync(join(g, 'skills'), { recursive: true });
    mkdirSync(c, { recursive: true });
    writeFileSync(join(g, 'memory.md'), '- 偏好繁體中文\n- 結尾附 TL;DR\n');
    writeFileSync(join(c, 'memory.md'), '- 偏好繁體中文\n- 用 pnpm 不用 npm\n'); // 第一條與 general 重複 → 去重
    writeFileSync(join(g, 'playbook.md'), '# 專案手冊\n\n## 整理 md\n產生 index.md。\n');
    writeFileSync(join(g, 'episodes.jsonl'),
      JSON.stringify({ id: 'e1', ts: '2026-06-01T00:00:00.000Z', summary: '舊', tags: ['a'], outcome: 'success' }) + '\n' +
      JSON.stringify({ id: 'e2', ts: '2026-06-20T00:00:00.000Z', summary: '新', tags: ['b'], outcome: 'failure' }) + '\n');
    writeFileSync(join(g, 'skills', 'make-index.md'), '---\ndescription: 產生 index.md\nusedCount: 3\nstale: false\n---\n\n# 目標\nx\n');
    writeFileSync(join(c, 'allow.json'), JSON.stringify({ tools: ['write'], bash: ['git status'] }));

    const e = readWorkspaceExperience(ws);
    assert.deepEqual([...e.packs].sort(), ['coding', 'general']);
    // 去重後恰 3 條（「偏好繁體中文」兩 pack 各一 → 只留一份）；順序依 readdir，故用集合比對
    assert.equal(e.memory.length, 3);
    assert.deepEqual([...e.memory].sort(), ['偏好繁體中文', '用 pnpm 不用 npm', '結尾附 TL;DR'].sort());
    assert.equal(e.playbook.length, 1);
    assert.equal(e.playbook[0].pack, 'general');
    assert.equal(e.skills[0].name, 'make-index');
    assert.equal(e.skills[0].used, 3);
    assert.deepEqual(e.episodes.map((x) => x.id), ['e2', 'e1']); // 新→舊
    assert.deepEqual(e.trust, { tools: ['write'], bash: ['git status'] });
    assert.deepEqual(e.counts, { memory: 3, playbook: 1, skills: 1, episodes: 2, trust: 2 });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('GET /v1/workspaces/experience：回傳工作區累積經驗（需 token）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-expapi-'));
  const app = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 'et', baseDir: base });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  try {
    const g = join(base, 'ws', 'demo', '.xitto-kernel', 'general');
    mkdirSync(g, { recursive: true });
    writeFileSync(join(g, 'memory.md'), '- 偏好繁體中文\n');
    const r = await fetch(`http://localhost:${port}/v1/workspaces/experience?ws=demo`, { headers: { authorization: 'Bearer et' } }).then((x) => x.json());
    assert.deepEqual(r.memory, ['偏好繁體中文']);
    assert.equal(r.counts.memory, 1);
    const un = await fetch(`http://localhost:${port}/v1/workspaces/experience?ws=demo`);
    assert.equal(un.status, 401); // 需 token
  } finally { await new Promise((r) => app.close(r)); rmSync(base, { recursive: true, force: true }); }
});

// 最小 docx（單一 stored entry，CRC 填 0——萃取器不驗 CRC）
function makeDocx(documentXml) {
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from(documentXml, 'utf8');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); name.copy(local, 30);
  const localFull = Buffer.concat([local, data]);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42); name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(localFull.length, 16);
  return Buffer.concat([localFull, central, eocd]);
}

test('GET /v1/workspaces/file?as=text：Word 萃取成文字；無 as 回原檔', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-doc-'));
  const app = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 'dt', baseDir: base });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  try {
    const wsdir = join(base, 'ws', 'demo'); mkdirSync(wsdir, { recursive: true });
    writeFileSync(join(wsdir, 'r.docx'), makeDocx('<w:document><w:body><w:p><w:r><w:t>報告 A &amp; B</w:t></w:r></w:p></w:body></w:document>'));
    const u = `http://localhost:${port}/v1/workspaces/file?ws=demo&path=r.docx`;
    // as=text → 純文字（含實體解碼）
    const t = await fetch(`${u}&as=text`, { headers: { authorization: 'Bearer dt' } });
    assert.equal(t.status, 200);
    assert.match(t.headers.get('content-type') || '', /text\/plain/);
    assert.equal((await t.text()).trim(), '報告 A & B');
    // 無 as → 回原檔（非萃取文字）
    const raw = await fetch(u, { headers: { authorization: 'Bearer dt' } });
    assert.equal(raw.status, 200);
    assert.ok(!(await raw.text()).includes('報告 A & B')); // 原檔是壓縮容器,不含明文
  } finally { await new Promise((r) => app.close(r)); rmSync(base, { recursive: true, force: true }); }
});

test('GET / 服務許願台網頁，token 注入、公開可載入（免 auth）', async () => {
  const app = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 'webtok-123', baseDir: '.xitto-server-test' });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  try {
    // 沒帶 token 也能拿到頁面（頁面本身公開）
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /任務台/);
    assert.match(html, /webtok-123/);                 // token 已注入供同源呼叫
    assert.doesNotMatch(html, /__SERVER_TOKEN__/);    // 佔位符已替換
    assert.match(html, /general/);                    // packs 已注入
    // API 仍需 token
    const un = await fetch(`http://localhost:${port}/v1/tasks`);
    assert.equal(un.status, 401);
  } finally { await new Promise((r) => app.close(r)); }
});
