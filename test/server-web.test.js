// 許願台網頁 + 交付檔案端點：UI 服務（token 注入）、resolveArtifact 防穿越。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApp, resolveArtifact, listWorkspaceFiles, safeWs, workspaceDir } from '../src/app/server.js';

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
    const f = await fetch(`http://localhost:${hosted.address().port}/v1/fs?path=${encodeURIComponent(root)}`, { headers: { authorization: 'Bearer t' } });
    assert.equal(f.status, 403);                    // 託管模式不給瀏覽主機
  } finally { await new Promise((r) => local.close(r)); await new Promise((r) => hosted.close(r)); rmSync(root, { recursive: true, force: true }); }
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
    assert.match(html, /許願台/);
    assert.match(html, /webtok-123/);                 // token 已注入供同源呼叫
    assert.doesNotMatch(html, /__SERVER_TOKEN__/);    // 佔位符已替換
    assert.match(html, /general/);                    // packs 已注入
    // API 仍需 token
    const un = await fetch(`http://localhost:${port}/v1/tasks`);
    assert.equal(un.status, 401);
  } finally { await new Promise((r) => app.close(r)); }
});
