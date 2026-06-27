// 許願台網頁 + 交付檔案端點：UI 服務（token 注入）、resolveArtifact 防穿越。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerApp, resolveArtifact } from '../src/app/server.js';

test('resolveArtifact：合法相對路徑 → 解析；穿越/絕對路徑 → null', () => {
  assert.equal(resolveArtifact('/base/s1', 'a.txt'), '/base/s1/a.txt');
  assert.equal(resolveArtifact('/base/s1', 'sub/b.txt'), '/base/s1/sub/b.txt');
  assert.equal(resolveArtifact('/base/s1', '../../etc/passwd'), null);
  assert.equal(resolveArtifact('/base/s1', '/etc/passwd'), null);
  assert.equal(resolveArtifact('/base/s1', ''), null);
  assert.equal(resolveArtifact('/base/s1', null), null);
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
