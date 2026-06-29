// uiux pack：工具齊（fs + glob/grep + web + bash）、read-before-edit 守衛、a11y verify 守門。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createUiuxPack, auditHtml } from '../src/packs/uiux/index.js';

test('uiux pack：工具齊（fs + glob/grep + web_search/web_fetch + bash）', () => {
  const k = createKernel(createUiuxPack());
  for (const n of ['read', 'ls', 'glob', 'grep', 'web_search', 'web_fetch', 'write', 'edit', 'bash']) assert.ok(k.registry.has(n), n);
  assert.ok([...k.mutatingTools].includes('write'));
  assert.ok([...k.mutatingTools].includes('edit'));
});

test('uiux pack：read-before-edit 守衛（共用 fs-tools）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-'));
  try {
    writeFileSync(join(dir, 'page.html'), '<button>送出</button>\n');
    const k = createKernel(createUiuxPack({ cwd: dir }), { cwd: dir });
    const blocked = await k.runTool('edit', { path: 'page.html', oldText: '送出', newText: '確認' });
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason, /read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auditHtml：抓出 lang / viewport / img alt / 無標籤圖示按鈕', () => {
  const bad = `<!doctype html><html><head><title>x</title></head><body>
    <img src="a.png">
    <button>🔍</button>
    <a href="/x"><svg></svg></a>
  </body></html>`;
  const issues = auditHtml(bad, 'bad.html').join('\n');
  assert.match(issues, /lang/);
  assert.match(issues, /viewport/);
  assert.match(issues, /img/i);
  assert.match(issues, /aria-label/);
});

test('auditHtml：合規頁面 → 無問題', () => {
  const ok = `<!doctype html><html lang="zh-Hant"><head><meta name="viewport" content="width=device-width">
    <title>ok</title></head><body>
    <img src="a.png" alt="示意圖">
    <button aria-label="搜尋">🔍</button>
    <a href="/x">關於我們</a>
  </body></html>`;
  assert.deepEqual(auditHtml(ok, 'ok.html'), []);
});

test('uiux pack：verify 在改動且有 HTML 問題時回灌、合規時放行', async () => {
  const pack = createUiuxPack();
  const dir = mkdtempSync(join(tmpdir(), 'uxv-'));
  try {
    // 有問題 → ok:false 並列出
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><img src="x.png"></body></html>');
    const bad = await pack.verify.run({ turnModified: true, cwd: dir });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /alt|lang|viewport/);

    // 修好 → ok:true
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>t</title></head><body><img src="x.png" alt="x"></body></html>');
    const good = await pack.verify.run({ turnModified: true, cwd: dir });
    assert.equal(good.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
