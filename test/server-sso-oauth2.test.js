// SSO OAuth2/OIDC（S3）：以 mock IdP 跑完整 Authorization Code flow，驗 login→callback→cookie session→授權。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createServerApp } from '../src/app/server.js';
import { oauth2Auth, parseTtl } from '../src/app/auth-oauth2.js';

const listen = (srv) => new Promise((r) => srv.listen(0, () => r(srv.address().port)));
const getCookie = (res, name) => {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(name + '=')) return c.slice(name.length + 1).split(';')[0];
  return null;
};

// mock IdP：discovery + JWKS + token 端點。token 端點按 test 設定的 nextClaims 簽發 id_token。
async function startMockIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test-key'; jwk.alg = 'RS256'; jwk.use = 'sig';
  const ctl = { issuer: '', nextClaims: null }; // test 在 callback 前塞入本次要簽發的 claims（含 nonce）
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/.well-known/openid-configuration') {
      return res.end(JSON.stringify({ issuer: ctl.issuer, authorization_endpoint: ctl.issuer + '/authorize', token_endpoint: ctl.issuer + '/token', jwks_uri: ctl.issuer + '/jwks' }));
    }
    if (url.pathname === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === '/token' && req.method === 'POST') {
      const c = ctl.nextClaims || {};
      const idToken = await new SignJWT({ email: c.email, email_verified: c.email_verified, name: c.name, nonce: c.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setSubject(c.sub || 'u1')
        .setIssuedAt().setIssuer(ctl.issuer).setAudience('test-client').setExpirationTime('5m').sign(privateKey);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ token_type: 'Bearer', id_token: idToken }));
    }
    res.writeHead(404); res.end();
  });
  const port = await listen(srv);
  ctl.issuer = `http://localhost:${port}`;
  return { ctl, close: () => srv.close() };
}

// 完整跑一次 login → callback，回傳 { loginRes, cbRes, session }。onNonce 讓 test 依 login 取得的 nonce 設定 IdP 要簽發的 claims。
async function runFlow(xittoUrl, idp, claims) {
  const loginRes = await fetch(xittoUrl('/auth/login'), { redirect: 'manual' });
  const loc = new URL(loginRes.headers.get('location'));
  const tx = getCookie(loginRes, 'xitto_tx');
  const state = loc.searchParams.get('state');
  const nonce = loc.searchParams.get('nonce');
  idp.ctl.nextClaims = { ...claims, nonce }; // IdP 簽發帶正確 nonce 的 id_token
  const cbRes = await fetch(xittoUrl(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`), { headers: { cookie: 'xitto_tx=' + tx }, redirect: 'manual' });
  return { loginRes, loc, cbRes, session: getCookie(cbRes, 'xitto_session') };
}

test('parseTtl：8h/30m/3600/壞值', () => {
  assert.equal(parseTtl('8h'), 8 * 3600);
  assert.equal(parseTtl('30m'), 1800);
  assert.equal(parseTtl('3600'), 3600);
  assert.equal(parseTtl('2d'), 2 * 86400);
  assert.equal(parseTtl('xyz'), 0);
  assert.equal(parseTtl(''), 0);
});

test('oauth2Auth：缺 cookieSecret / clientId / issuer → 建構期報錯', () => {
  assert.throws(() => oauth2Auth({ clientId: 'c', redirectUri: 'r', issuer: 'i' }), /cookieSecret/);
  assert.throws(() => oauth2Auth({ cookieSecret: 's', redirectUri: 'r', issuer: 'i' }), /clientId/);
  assert.throws(() => oauth2Auth({ cookieSecret: 's', clientId: 'c', redirectUri: 'r' }), /issuer|端點/);
});

test('OAuth2 端到端：login → callback → cookie session → 授權；封閉名冊拒陌生人；break-glass；壞 state/竄改 cookie', async () => {
  const idp = await startMockIdp();
  const base = mkdtempSync(join(tmpdir(), 'xk-oidc-'));
  const auth = oauth2Auth({
    issuer: idp.ctl.issuer, clientId: 'test-client', clientSecret: 'secret',
    redirectUri: 'http://localhost/auth/callback', cookieSecret: 'x'.repeat(32),
    masterToken: 'master-tok', secureCookie: false, // 測試走 http
  });
  const srv = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', auth, adminEmails: ['admin@corp.com'], allowedEmailDomain: '', baseDir: join(base, '.srv') });
  const port = await listen(srv);
  const U = (p) => `http://localhost:${port}${p}`;
  try {
    // 未登入 → /v1/models 401
    assert.equal((await fetch(U('/v1/models'))).status, 401, '未登入擋下');

    // 1) admin（在釘死名冊）完整登入 → 302 到 '/'，拿到 session cookie
    const okFlow = await runFlow(U, idp, { email: 'admin@corp.com', email_verified: true, name: 'Boss', sub: 'boss-1' });
    assert.equal(okFlow.loginRes.status, 302);
    assert.match(okFlow.loc.pathname, /\/authorize$/);
    assert.ok(okFlow.loc.searchParams.get('code_challenge'), 'login 帶 PKCE code_challenge');
    assert.equal(okFlow.loc.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(okFlow.cbRes.status, 302);
    assert.equal(okFlow.cbRes.headers.get('location'), '/');
    assert.ok(okFlow.session, 'callback 發出 xitto_session cookie');

    // 帶 session → /v1/models 200
    assert.equal((await fetch(U('/v1/models'), { headers: { cookie: 'xitto_session=' + okFlow.session } })).status, 200, 'admin session 放行');

    // /v1/me：未登入 → authenticated:false；帶 session → 回身份 + 角色
    const meAnon = await fetch(U('/v1/me')).then((r) => r.json());
    assert.deepEqual(meAnon, { ssoActive: true, authenticated: false }, '未登入 /v1/me');
    const me = await fetch(U('/v1/me'), { headers: { cookie: 'xitto_session=' + okFlow.session } }).then((r) => r.json());
    assert.equal(me.authenticated, true); assert.equal(me.email, 'admin@corp.com'); assert.equal(me.name, 'Boss'); assert.equal(me.role, 'admin');

    // 竄改 session cookie → 視為未登入 401
    assert.equal((await fetch(U('/v1/models'), { headers: { cookie: 'xitto_session=' + okFlow.session + 'x' } })).status, 401, '竄改簽章被拒');

    // 2) 陌生人（不在名冊、無網域放行）→ callback 403（封閉名冊）
    const stranger = await runFlow(U, idp, { email: 'nobody@other.com', email_verified: true, name: 'X', sub: 'x-1' });
    assert.equal(stranger.cbRes.status, 403, '封閉名冊：登入成功但無授權');
    assert.equal(getCookie(stranger.cbRes, 'xitto_session'), null, '陌生人不發 session');

    // 3) break-glass：master token bearer → /v1/models 200（繞過 SSO）
    assert.equal((await fetch(U('/v1/models'), { headers: { authorization: 'Bearer master-tok' } })).status, 200, 'break-glass token');

    // 3b) 前端（S4）：未登入首頁 → 導向登入；邀請訪客頁不強制登入；已登入頁面不外洩 master token
    const homeRedir = await fetch(U('/'), { redirect: 'manual' });
    assert.equal(homeRedir.status, 302, '未登入首頁導向登入');
    assert.match(homeRedir.headers.get('location'), /\/auth\/login\?returnTo=/);
    assert.equal((await fetch(U('/room?room=abc'), { redirect: 'manual' })).status, 200, '邀請訪客頁（?room=）不強制登入');
    const homeIn = await fetch(U('/'), { headers: { cookie: 'xitto_session=' + okFlow.session } });
    assert.equal(homeIn.status, 200, '已登入可載入首頁');
    assert.ok(!(await homeIn.text()).includes('master-tok'), 'SSO 下頁面不注入 master token（防提權）');

    // 3c) 會議室 join（S4）：用 SSO 已驗證身份當顯示名，不信任前端傳入的 name
    const H = { 'content-type': 'application/json', cookie: 'xitto_session=' + okFlow.session };
    const room = await fetch(U('/v1/rooms'), { method: 'POST', headers: H, body: '{}' }).then((r) => r.json());
    const joined = await fetch(U(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: H, body: JSON.stringify({ name: 'IGNORED' }) }).then((r) => r.json());
    assert.ok(joined.memberId, 'join 成功');
    const view = await fetch(U(`/v1/rooms/${room.roomId}`), { headers: H }).then((r) => r.json());
    assert.ok(view.members.includes('Boss'), 'join 綁 SSO 身份（principal.name）');
    assert.ok(!view.members.includes('IGNORED'), '不採用前端傳入的 name');

    // 4) 壞 state → callback 400
    const loginRes = await fetch(U('/auth/login'), { redirect: 'manual' });
    const tx = getCookie(loginRes, 'xitto_tx');
    const bad = await fetch(U('/auth/callback?code=abc&state=WRONG'), { headers: { cookie: 'xitto_tx=' + tx }, redirect: 'manual' });
    assert.equal(bad.status, 400, 'state 不符被拒');

    // 5) logout 清 cookie
    const lo = await fetch(U('/auth/logout'), { redirect: 'manual' });
    assert.equal(lo.status, 302);
    assert.match(getCookie(lo, 'xitto_session') === '' ? 'cleared' : String(getCookie(lo, 'xitto_session')), /cleared|^$/);
  } finally { srv.close(); idp.close(); rmSync(base, { recursive: true, force: true }); }
});
