// 自簽 TLS（HTTPS）：私有化/區網部署免反代即可跑 HTTPS，讓瀏覽器把來源視為安全上下文（會議室錄音要用）。
// openssl 不在環境時整檔跳過（不讓缺工具的 CI 誤紅）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServerApp, ensureSelfSignedCert } from '../src/app/server.js';

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('ensureSelfSignedCert：產生含 SAN 的自簽憑證並快取；再次呼叫沿用不重產', { skip: hasOpenssl ? false : 'no openssl' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-tls-'));
  try {
    const c1 = ensureSelfSignedCert(base, { hosts: ['myhost.local'], ips: ['192.168.1.9'] });
    assert.equal(c1.generated, true, '首次應產生');
    assert.ok(existsSync(c1.certPath) && existsSync(c1.keyPath), '憑證/私鑰落地');
    assert.ok(c1.cert.length > 0 && c1.key.length > 0);
    const txt = execFileSync('openssl', ['x509', '-in', c1.certPath, '-noout', '-text'], { encoding: 'utf8' });
    assert.ok(txt.includes('DNS:localhost'), 'SAN 含 localhost');
    assert.ok(txt.includes('192.168.1.9'), 'SAN 含傳入區網 IP');
    assert.ok(txt.includes('myhost.local'), 'SAN 含傳入主機名');
    const c2 = ensureSelfSignedCert(base, { hosts: ['myhost.local'], ips: ['192.168.1.9'] });
    assert.equal(c2.generated, false, '第二次沿用快取');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('createServerApp with tls：起 HTTPS 服務，/health 走 https 回應', { skip: hasOpenssl ? false : 'no openssl' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-tls2-'));
  const c = ensureSelfSignedCert(base, { hosts: [], ips: [] });
  const app = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', local: true, baseDir: join(base, '.srv'), tls: { cert: c.cert, key: c.key } });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 自簽 → 測試放行
  try {
    const r = await fetch(`https://localhost:${port}/health`).then((x) => x.json());
    assert.equal(r.ok, true, 'https /health 正常');
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    await new Promise((r) => app.close(r)); rmSync(base, { recursive: true, force: true });
  }
});
