// 許願台網頁 + 交付檔案端點：UI 服務（token 注入）、resolveArtifact 防穿越。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApp, resolveArtifact, listWorkspaceFiles, listDir, safeWs, workspaceDir, readWorkspaceExperience } from '../src/app/server.js';
import { writeArtifactMetadata } from '../src/packs/shared/artifact-metadata.js';
import { createKernel } from '../src/kernel/index.js';
import { createDocgenPack } from '../src/packs/docgen/index.js';

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

test('本地自用（--local 非 SSO）：/settings 與 /v1/setup 免 token；託管模式仍限 token（401）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xk-localauth-'));
  const local = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 'dev-token', local: true, baseDir: join(root, '.srv') });
  const hosted = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 'dev-token', local: false, baseDir: join(root, '.srv2') });
  await new Promise((r) => local.listen(0, r)); await new Promise((r) => hosted.listen(0, r));
  const U = (s, p) => `http://localhost:${s.address().port}${p}`;
  try {
    // 本地：不帶 token 也能開設定頁（GET /settings → 200 HTML），管理 POST（/v1/setup 校驗錯誤走到 400 而非 401）
    const page = await fetch(U(local, '/settings'));
    assert.equal(page.status, 200, '本地免 token 開設定頁');
    const setup = await fetch(U(local, '/v1/setup'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.notEqual(setup.status, 401, '本地免 token 打管理端點（不因缺 token 被 401）');
    // 託管：不帶 token → 401（維持原行為，不誤開後門）
    assert.equal((await fetch(U(hosted, '/settings'))).status, 401, '託管缺 token → 401');
    assert.equal((await fetch(U(hosted, '/v1/setup'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, '託管管理端點缺 token → 401');
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

function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const localFull = Buffer.concat([local, data]);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(localFull); centrals.push(central); offset += localFull.length;
  }
  const localAll = Buffer.concat(locals), cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(localAll.length, 16);
  return Buffer.concat([localAll, cd, eocd]);
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');

function makePptxTemplate() {
  const presentation = '<p:presentation><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/></p:presentation>';
  const presRels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>';
  const master = '<p:sldMaster/>';
  const masterRels = '<Relationships>' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>';
  const layout = '<p:sldLayout name="Title Picture Content"><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="914400"/></a:xfrm></p:spPr></p:sp>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1485900"/><a:ext cx="4572000" cy="3429000"/></a:xfrm></p:spPr></p:sp>' +
    '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture Placeholder"/><p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="3"/></p:nvPr></p:nvPicPr><p:spPr><a:xfrm><a:off x="5486400" y="1485900"/><a:ext cx="3200400" cy="1800000"/></a:xfrm></p:spPr></p:pic>' +
    '</p:spTree></p:cSld></p:sldLayout>';
  const theme = '<a:theme name="Corp"><a:themeElements><a:clrScheme><a:srgbClr val="1F4E79"/><a:srgbClr val="F2F2F2"/></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Microsoft JhengHei"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>';
  return makeZip([
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: masterRels },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/theme/theme1.xml', data: theme },
  ]);
}

test('GET /v1/workspaces/file?as=text/as=preview：Word 可萃取成文字與結構化預覽；無 as 回原檔', async () => {
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
    // as=preview → 結構化 JSON，供網頁 Office 預覽保留段落/表格/投影片/工作表等結構
    const p = await fetch(`${u}&as=preview`, { headers: { authorization: 'Bearer dt' } });
    assert.equal(p.status, 200);
    assert.match(p.headers.get('content-type') || '', /application\/json/);
    const preview = await p.json();
    assert.equal(preview.ok, true);
    assert.equal(preview.kind, 'docx');
    assert.equal(preview.text, '報告 A & B');
    assert.deepEqual(preview.blocks, [{ type: 'paragraph', text: '報告 A & B' }]);
    // 無 as → 回原檔（非萃取文字）
    const raw = await fetch(u, { headers: { authorization: 'Bearer dt' } });
    assert.equal(raw.status, 200);
    assert.ok(!(await raw.text()).includes('報告 A & B')); // 原檔是壓縮容器,不含明文
  } finally { await new Promise((r) => app.close(r)); rmSync(base, { recursive: true, force: true }); }
});

test('GET /v1/workspaces/file?as=preview：預覽 JSON 過大時移除 PPTX 圖片 dataUrl', async () => {
  const oldLimit = process.env.XITTO_PREVIEW_JSON_MAX_BYTES;
  process.env.XITTO_PREVIEW_JSON_MAX_BYTES = '900';
  const base = mkdtempSync(join(tmpdir(), 'xk-preview-limit-'));
  const app = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 'pt', baseDir: base });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  try {
    const wsdir = join(base, 'ws', 'demo'); mkdirSync(wsdir, { recursive: true });
    const slide = '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>含圖頁</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
    const rels = '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>';
    writeFileSync(join(wsdir, 'deck.pptx'), makeZip([
      { name: 'ppt/slides/slide1.xml', data: slide },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels },
      { name: 'ppt/media/image1.png', data: Buffer.alloc(700, 1) },
    ]));
    const r = await fetch(`http://localhost:${port}/v1/workspaces/file?ws=demo&path=deck.pptx&as=preview`, { headers: { authorization: 'Bearer pt' } });
    assert.equal(r.status, 200);
    const preview = await r.json();
    assert.equal(preview.previewLimited, true);
    assert.match(preview.warnings[0], /略過/);
    assert.equal(preview.slides[0].images[0].omitted, true);
    assert.equal(preview.slides[0].images[0].dataUrl, undefined);
    assert.equal(preview.slides[0].images[0].size, 700);
  } finally {
    if (oldLimit == null) delete process.env.XITTO_PREVIEW_JSON_MAX_BYTES;
    else process.env.XITTO_PREVIEW_JSON_MAX_BYTES = oldLimit;
    await new Promise((r) => app.close(r)); rmSync(base, { recursive: true, force: true });
  }
});

test('GET /v1/workspaces/file?as=preview：合併生成品質 metadata', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-preview-meta-'));
  const app = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 'mt', baseDir: base });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  try {
    const wsdir = join(base, 'ws', 'demo'); mkdirSync(wsdir, { recursive: true });
    const file = join(wsdir, 'r.docx');
    writeFileSync(file, makeDocx('<w:document><w:body><w:p><w:r><w:t>交付文件</w:t></w:r></w:p></w:body></w:document>'));
    writeArtifactMetadata(wsdir, file, {
      artifact: 'document',
      format: 'docx',
      quality: { ok: true, grade: 'pass', score: 100, issueCount: 0, repairCount: 0, timingsMs: { total: 12 } },
      verify: { ok: true, design: { ok: true, score: 100, issues: [] }, issues: [] },
      repairs: [],
      repaired: false,
    });
    const r = await fetch(`http://localhost:${port}/v1/workspaces/file?ws=demo&path=r.docx&as=preview`, { headers: { authorization: 'Bearer mt' } });
    assert.equal(r.status, 200);
    const preview = await r.json();
    assert.equal(preview.kind, 'docx');
    assert.equal(preview.artifactMeta.artifact, 'document');
    assert.equal(preview.quality.grade, 'pass');
    assert.equal(preview.quality.timingsMs.total, 12);
    assert.equal(preview.verify.ok, true);
    assert.deepEqual(preview.repairs, []);
  } finally { await new Promise((r) => app.close(r)); rmSync(base, { recursive: true, force: true }); }
});

test('PPT 生成到網頁預覽：內容結構、品質、修正與 metadata 端到端可見', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-ppt-preview-e2e-'));
  const app = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 'ppt', baseDir: base });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  try {
    const wsdir = join(base, 'ws', 'demo'); mkdirSync(wsdir, { recursive: true });
    writeFileSync(join(wsdir, 'template.pptx'), makePptxTemplate());
    writeFileSync(join(wsdir, 'logo.png'), PNG_1X1);
    const k = createKernel(createDocgenPack({ cwd: wsdir }), { cwd: wsdir });
    const body = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 個重點，驗證長正文會拆頁`);
    const tool = await k.runTool('generate_pptx_from_template', {
      template: 'template.pptx',
      path: 'deck.pptx',
      slides: [{
        title: '這是一個非常非常長的投影片標題，應該被自動縮短以避免超出版面',
        body,
        images: ['logo.png'],
        tables: [{ name: 'KPI', rows: [['指標', '數值'], ['收入', '100'], ['成本', '40']] }],
        charts: [{ name: '趨勢', type: 'bar', categories: ['Q1', 'Q2', 'Q3'], values: [10, 20, 30] }],
      }],
    });
    const generated = JSON.parse(tool.result.content[0].text);
    assert.equal(generated.ok, true);
    assert.equal(generated.repaired, true);
    assert.equal(generated.quality.ok, true);
    assert.match(generated.repairs.map((r) => r.code).join('\n'), /title-shortened/);
    assert.match(generated.repairs.map((r) => r.code).join('\n'), /visual-split/);

    const r = await fetch(`http://localhost:${port}/v1/workspaces/file?ws=demo&path=deck.pptx&as=preview`, { headers: { authorization: 'Bearer ppt' } });
    assert.equal(r.status, 200);
    const preview = await r.json();
    assert.equal(preview.kind, 'pptx');
    assert.equal(preview.artifactMeta.artifact, 'pptx-template');
    assert.equal(preview.quality.grade, 'pass');
    assert.equal(preview.verify.ok, true);
    assert.equal(preview.verify.design.score, 100);
    assert.equal(preview.repairs.length, 2);
    assert.ok(preview.slides.length >= 3);
    assert.equal(preview.slides[0].images.length, 0);
    assert.equal(preview.slides[0].tables.length, 0);
    assert.equal(preview.slides[0].charts.length, 0);
    assert.equal(preview.slides[0].body.length, 5);
    assert.equal(preview.slides[1].body.length, 5);
    assert.ok(preview.slides[2].images.length >= 1);
    assert.ok(preview.slides[2].tables.length >= 1);
    assert.ok(preview.slides[2].charts.length >= 1);
    assert.equal(preview.slides[2].body.length, 0);
  } finally { await new Promise((r) => app.close(r)); rmSync(base, { recursive: true, force: true }); }
});

test('GET /v1/workspaces/file?as=preview：檔案覆寫後不套用過期品質 metadata', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-preview-stale-meta-'));
  const app = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 'stale', baseDir: base });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  try {
    const wsdir = join(base, 'ws', 'demo'); mkdirSync(wsdir, { recursive: true });
    const file = join(wsdir, 'r.docx');
    writeFileSync(file, makeDocx('<w:document><w:body><w:p><w:r><w:t>舊交付文件</w:t></w:r></w:p></w:body></w:document>'));
    writeArtifactMetadata(wsdir, file, {
      artifact: 'document',
      format: 'docx',
      quality: { ok: true, grade: 'pass', score: 100, issueCount: 0, repairCount: 0, timingsMs: { total: 12 } },
      verify: { ok: true, design: { ok: true, score: 100, issues: [] }, issues: [] },
    });
    writeFileSync(file, makeDocx('<w:document><w:body><w:p><w:r><w:t>新文件內容不同而且更長</w:t></w:r></w:p></w:body></w:document>'));
    const r = await fetch(`http://localhost:${port}/v1/workspaces/file?ws=demo&path=r.docx&as=preview`, { headers: { authorization: 'Bearer stale' } });
    assert.equal(r.status, 200);
    const preview = await r.json();
    assert.equal(preview.kind, 'docx');
    assert.equal(preview.text, '新文件內容不同而且更長');
    assert.equal(preview.artifactMeta, undefined);
    assert.equal(preview.quality, undefined);
    assert.equal(preview.verify, undefined);
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

test('技能市集端點：list(authed) / add·install(local) / experience 併入插件技能 / 託管禁改', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xk-mkt-'));
  const prevEnv = process.env.XITTO_SKILLS_DIR;
  process.env.XITTO_SKILLS_DIR = join(root, 'skills-root'); // 隔離：市集註冊表寫到 temp，不碰真實 ~/.xitto-code
  // 本地市集：demo/skills/hello.md
  const mp = join(root, 'market');
  mkdirSync(join(mp, 'demo', 'skills'), { recursive: true });
  writeFileSync(join(mp, 'demo', 'skills', 'hello.md'), '---\ndescription: 插件打招呼\n---\n# 步驟\n說 hi');
  const local = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', local: true, baseDir: join(root, '.srv') });
  const hosted = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', local: false, baseDir: join(root, '.srv2') });
  await new Promise((r) => local.listen(0, r)); await new Promise((r) => hosted.listen(0, r));
  const U = (s, p) => `http://localhost:${s.address().port}${p}`;
  const H = { authorization: 'Bearer t', 'content-type': 'application/json' };
  try {
    // list 需 token
    assert.equal((await fetch(U(local, '/v1/marketplace'))).status, 401);
    assert.deepEqual((await fetch(U(local, '/v1/marketplace'), { headers: H }).then((x) => x.json())).marketplaces, []);
    // add（本地）→ 發現 demo
    const add = await fetch(U(local, '/v1/marketplace/add'), { method: 'POST', headers: H, body: JSON.stringify({ name: 'mk', source: mp }) }).then((x) => x.json());
    assert.equal(add.added, 'mk');
    assert.deepEqual(add.plugins, ['demo']);
    // install → 技能併入
    const inst = await fetch(U(local, '/v1/marketplace/install'), { method: 'POST', headers: H, body: JSON.stringify({ plugin: 'demo' }) }).then((x) => x.json());
    assert.equal(inst.installed, 'demo@mk');
    // experience 面板現在看得到插件技能（scope=plugin + source）
    const exp = await fetch(U(local, '/v1/workspaces/experience?ws=default'), { headers: H }).then((x) => x.json());
    const hello = exp.skills.find((s) => s.name === 'hello');
    assert.ok(hello && hello.scope === 'plugin' && hello.source === 'mk/demo', '插件技能應併入知識面板並標來源');
    // 託管模式：改市集被擋（403），但 list 可讀
    assert.equal((await fetch(U(hosted, '/v1/marketplace/add'), { method: 'POST', headers: H, body: JSON.stringify({ name: 'x', source: mp }) })).status, 403);
    assert.equal((await fetch(U(hosted, '/v1/marketplace'), { headers: H })).status, 200);
  } finally {
    await new Promise((r) => local.close(r)); await new Promise((r) => hosted.close(r));
    if (prevEnv === undefined) delete process.env.XITTO_SKILLS_DIR; else process.env.XITTO_SKILLS_DIR = prevEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
