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

// mock CAS 風格 IdP（非 OIDC）：token 端點只回 access_token（無 id_token）；profile 端點回嵌套 attributes（企業 CAS 常見形狀）。
async function startMockCas() {
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/token' && req.method === 'POST') {
      // 部分 CAS 規範：參數拼在 url 上。要求 query 帶齊 grant_type/code/client_secret，否則 400（驗證 tokenParamsIn='query'）。
      const q = url.searchParams;
      if (q.get('grant_type') !== 'authorization_code' || !q.get('code') || q.get('client_secret') !== 's') { res.writeHead(400); return res.end('params must be in url'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'at-123', token_type: 'Bearer', expires_in: 3600 }));
    }
    if (url.pathname === '/profile') { // 需帶 ?access_token=
      if (url.searchParams.get('access_token') !== 'at-123') { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: '12345', attributes: { user_name: '張三', email: 'zhangsan@corp.com', ad_account: 'zhangsan', work_no: 'N1' } }));
    }
    res.writeHead(404); res.end();
  });
  return listen(srv).then((port) => ({ base: `http://localhost:${port}`, close: () => srv.close() }));
}

test('OAuth2 userinfo 模式（無 id_token，如企業 CAS）：login 無 PKCE → callback → profile → session → 授權；logout 連 IdP', async () => {
  const idp = await startMockCas();
  const base = mkdtempSync(join(tmpdir(), 'xk-cas-'));
  const auth = oauth2Auth({
    authorizationEndpoint: idp.base + '/authorize', tokenEndpoint: idp.base + '/token', userinfoEndpoint: idp.base + '/profile',
    usePkce: false, tokenParamsIn: 'query', logoutEndpoint: idp.base + '/logout', logoutReturnParam: 'returnurl',
    clientId: 'c', clientSecret: 's', redirectUri: 'http://localhost/auth/callback',
    cookieSecret: 'x'.repeat(32), secureCookie: false,
  });
  const srv = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', auth, adminEmails: ['zhangsan@corp.com'], baseDir: join(base, '.srv') });
  const port = await listen(srv); const U = (p) => `http://localhost:${port}${p}`;
  try {
    // login：usePkce=false → 授權連結不帶 PKCE
    const loginRes = await fetch(U('/auth/login'), { redirect: 'manual' });
    const loc = new URL(loginRes.headers.get('location'));
    assert.ok(!loc.searchParams.get('code_challenge'), 'usePkce=false → 不帶 code_challenge');
    const tx = getCookie(loginRes, 'xitto_tx'); const state = loc.searchParams.get('state');
    // callback：無 id_token → 打 profile 取身份
    const cb = await fetch(U(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`), { headers: { cookie: 'xitto_tx=' + tx }, redirect: 'manual' });
    assert.equal(cb.status, 302); const session = getCookie(cb, 'xitto_session');
    assert.ok(session, 'userinfo 模式也發 session cookie');
    // /v1/me：嵌套 attributes 正確映射（user_name→name、attributes.email→email）
    const me = await fetch(U('/v1/me'), { headers: { cookie: 'xitto_session=' + session } }).then((r) => r.json());
    assert.equal(me.email, 'zhangsan@corp.com'); assert.equal(me.name, '張三'); assert.equal(me.role, 'admin');
    assert.equal((await fetch(U('/v1/models'), { headers: { cookie: 'xitto_session=' + session } })).status, 200, 'admin session 放行');
    // logout：連 IdP 單點登出，帶 returnurl
    const lo = await fetch(U('/auth/logout'), { redirect: 'manual' });
    assert.equal(lo.status, 302); assert.match(lo.headers.get('location'), /\/logout\?returnurl=/);
    assert.equal(getCookie(lo, 'xitto_session'), '', '本地 session 也清掉');
  } finally { srv.close(); idp.close(); rmSync(base, { recursive: true, force: true }); }
});

test('SSO 登入即放行：member（非 admin）能列房/建房/進房不被 401；改名冊/設定仍限 admin（403）', async () => {
  const idp = await startMockIdp();
  const base = mkdtempSync(join(tmpdir(), 'xk-member-'));
  const auth = oauth2Auth({
    issuer: idp.ctl.issuer, clientId: 'test-client', clientSecret: 'secret',
    redirectUri: 'http://localhost/auth/callback', cookieSecret: 'x'.repeat(32), secureCookie: false,
  });
  // 網域放行 → 該網域使用者自動得 member 角色（非 admin）。
  const srv = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', auth, adminEmails: ['boss@corp.com'], allowedEmailDomain: 'corp.com', baseDir: join(base, '.srv') });
  const port = await listen(srv); const U = (p) => `http://localhost:${port}${p}`;
  try {
    // member 登入（網域內、非釘死 admin）→ callback 成功發 session（不是 403）
    const flow = await runFlow(U, idp, { email: 'staff@corp.com', email_verified: true, name: '小明', sub: 's-1' });
    assert.equal(flow.cbRes.status, 302, 'member 登入成功（有角色，不被封閉名冊擋）');
    assert.ok(flow.session, 'member 也發 session cookie');
    const H = { 'content-type': 'application/json', cookie: 'xitto_session=' + flow.session };
    const me = await fetch(U('/v1/me'), { headers: H }).then((r) => r.json());
    assert.equal(me.role, 'member', '網域放行 → member');

    // 「只要 SSO 登入就不要 401」：列房/模型/建房/進房全放行
    assert.equal((await fetch(U('/v1/rooms'), { headers: H })).status, 200, 'member 列房不 401');
    assert.equal((await fetch(U('/v1/models'), { headers: H })).status, 200, 'member 取模型不 401');
    const room = await fetch(U('/v1/rooms'), { method: 'POST', headers: H, body: '{}' }).then((r) => r.json());
    assert.ok(room.roomId, 'member 可建房不 401');
    const joined = await fetch(U(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: H, body: '{}' }).then((r) => r.json());
    assert.ok(joined.memberId, 'member 可進房不 401');

    // 提權敏感端點仍限 admin：member 改名冊 / 開設定 → 403（非 401，語義為「已認證但無權限」）
    assert.equal((await fetch(U('/v1/admins'), { method: 'POST', headers: H, body: JSON.stringify({ email: 'staff@corp.com', role: 'admin' }) })).status, 403, 'member 不能改名冊（防自我提權）');
    assert.equal((await fetch(U('/v1/admins'), { headers: H })).status, 403, 'member 不能看名冊');
    assert.equal((await fetch(U('/settings'), { headers: H })).status, 403, 'member 不能開設定');
  } finally { srv.close(); idp.close(); rmSync(base, { recursive: true, force: true }); }
});

test('開放模式（ssoOpen）：任何 SSO 通過即得 member，不看名冊/網域；仍尊重釘死 admin', async () => {
  const idp = await startMockIdp();
  const base = mkdtempSync(join(tmpdir(), 'xk-open-'));
  const auth = oauth2Auth({
    issuer: idp.ctl.issuer, clientId: 'test-client', clientSecret: 'secret',
    redirectUri: 'http://localhost/auth/callback', cookieSecret: 'x'.repeat(32), secureCookie: false,
  });
  // ssoOpen=true：不設網域、不加名冊 → 任何登入者皆放行為 member；boss@corp.com 仍是釘死 admin。
  const srv = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', auth, adminEmails: ['boss@corp.com'], ssoOpen: true, baseDir: join(base, '.srv') });
  const port = await listen(srv); const U = (p) => `http://localhost:${port}${p}`;
  try {
    // 「陌生人」（不在名冊、無網域放行）在開放模式下 → 登入成功、得 member（封閉模式下本會 403）
    const flow = await runFlow(U, idp, { email: 'anyone@random.com', email_verified: true, name: '路人', sub: 'r-1' });
    assert.equal(flow.cbRes.status, 302, '開放模式：任何 SSO 身份都能登入（非 403）');
    const H = { cookie: 'xitto_session=' + flow.session };
    assert.equal((await fetch(U('/v1/me'), { headers: H }).then((r) => r.json())).role, 'member', '開放模式 → member');
    assert.equal((await fetch(U('/v1/rooms'), { headers: H })).status, 200, '進站可用不 401');
    // 釘死 admin 仍為 admin（開放模式不降級）
    const boss = await runFlow(U, idp, { email: 'boss@corp.com', email_verified: true, name: 'Boss', sub: 'b-1' });
    assert.equal((await fetch(U('/v1/me'), { headers: { cookie: 'xitto_session=' + boss.session } }).then((r) => r.json())).role, 'admin', '釘死 admin 不受開放模式影響');
  } finally { srv.close(); idp.close(); rmSync(base, { recursive: true, force: true }); }
});

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

    // 3d) 發言（回歸）：SSO 已登入者帶「成員 token」發言 → roomAuth 由 token 反查 memberId，不因 cookie principal 短路而漏。
    //     修前：roomAuth 先命中 cookie principal（無 memberId）→ say 拿不到 memberId → 誤報「請先加入房間」。
    const sayH = { 'content-type': 'application/json', cookie: 'xitto_session=' + okFlow.session, authorization: 'Bearer ' + joined.memberToken };
    const said = await fetch(U(`/v1/rooms/${room.roomId}/say`), { method: 'POST', headers: sayH, body: JSON.stringify({ text: 'hello room' }) });
    assert.equal(said.status, 200, 'SSO 成員帶成員 token 可發言（不誤報請先加入房間）');
    const sv = await fetch(U(`/v1/rooms/${room.roomId}`), { headers: H }).then((r) => r.json());
    assert.ok(sv.messages.some((m) => m.text === 'hello room' && m.name === 'Boss'), '發言綁 SSO 身份名（memberId 正確反查）');

    // 3e) 離開會議室（回大廳功能的後端）：憑成員 token 退場 → 成員名單移除 Boss。
    const left = await fetch(U(`/v1/rooms/${room.roomId}/leave`), { method: 'POST', headers: sayH, body: JSON.stringify({ memberId: joined.memberId }) });
    assert.equal(left.status, 200, 'SSO 成員可離開房間');
    const after = await fetch(U(`/v1/rooms/${room.roomId}`), { headers: H }).then((r) => r.json());
    assert.ok(!after.members.includes('Boss'), '離開後成員名單移除');

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
