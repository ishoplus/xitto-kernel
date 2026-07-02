// 通用 OAuth2 / OIDC 認證 adapter（見 docs/10-sso-design.md）。
// 只負責「認證/認人」：跑 Authorization Code flow（PKCE + state + nonce），驗 id_token 後發 cookie session。
// 「授權/誰是 admin」交給注入的 roleStore（xitto 自管名冊）——本模組不決定權限，只提供已驗證身份。
//
// 設計要點：
// - session/tx cookie 用自簽 HMAC-SHA256（同步驗證）→ authed()/roomAuth()/principal() 維持同步，不動 server.js 既有呼叫點。
// - 只有 callback 驗 IdP 的 id_token（RS256/JWKS）才用 jose（非同步，在 async handle 內）。
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { jwtVerify, createRemoteJWKSet, createLocalJWKSet } from 'jose';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => createHash('sha256').update(s).digest();
const nowSec = () => Math.floor(Date.now() / 1000);

// "8h" / "30m" / "3600" → 秒；無法解析回 0。
export const parseTtl = (v) => {
  if (!v) return 0;
  const m = String(v).trim().match(/^(\d+)\s*([smhd]?)$/);
  if (!m) return 0;
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's']);
};

const parseCookies = (req) => Object.fromEntries(
  String(req.headers?.cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => {
    const i = c.indexOf('='); return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)];
  }),
);

export function oauth2Auth(config = {}) {
  const {
    issuer, authorizationEndpoint, tokenEndpoint, jwksUri, jwks,
    clientId, clientSecret, redirectUri,
    scopes = ['openid', 'email', 'profile'],
    cookieSecret, sessionTtl = 8 * 3600, masterToken = '',
    roleStore: initialRoleStore = null, mapClaims, secureCookie = true,
  } = config;
  if (!cookieSecret) throw new Error('oauth2Auth 需要 cookieSecret（設 XITTO_COOKIE_SECRET）');
  if (!clientId || !redirectUri) throw new Error('oauth2Auth 需要 clientId 與 redirectUri');
  if (!issuer && !(authorizationEndpoint && tokenEndpoint && (jwksUri || jwks))) {
    throw new Error('oauth2Auth 需要 issuer（走 discovery）或顯式端點 authorization/token/jwks');
  }

  // 自簽 cookie：base64url(payload).base64url(hmac)。同步簽/驗，含 exp 檢查。
  const signCookie = (payload) => {
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(createHmac('sha256', cookieSecret).update(body).digest());
    return body + '.' + sig;
  };
  const verifyCookie = (tok) => {
    if (!tok || tok.indexOf('.') < 0) return null;
    const [body, sig] = tok.split('.');
    const expect = b64url(createHmac('sha256', cookieSecret).update(body).digest());
    if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); if (p.exp && nowSec() > p.exp) return null; return p; } catch { return null; }
  };

  const cookieStr = (name, value, { maxAge } = {}) => {
    let s = `${name}=${value}; Path=/; SameSite=Lax; HttpOnly`;
    if (secureCookie) s += '; Secure';
    if (maxAge != null) s += `; Max-Age=${maxAge}`;
    return s;
  };
  const appendCookie = (res, str) => {
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', prev ? [...(Array.isArray(prev) ? prev : [prev]), str] : [str]);
  };

  // OIDC discovery（lazy + 快取）：給了顯式端點就不打 discovery。
  let meta = null;
  const discover = async () => {
    if (meta) return meta;
    if (authorizationEndpoint && tokenEndpoint && (jwksUri || jwks)) {
      meta = { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, jwks_uri: jwksUri, issuer };
    } else {
      const r = await fetch(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
      if (!r.ok) throw new Error('OIDC discovery 失敗：HTTP ' + r.status);
      meta = await r.json();
    }
    return meta;
  };
  let jwkSet = null;
  const getJwks = async () => {
    if (jwkSet) return jwkSet;
    const m = await discover();
    jwkSet = jwks ? createLocalJWKSet(typeof jwks === 'string' ? JSON.parse(jwks) : jwks)
      : createRemoteJWKSet(new URL(m.jwks_uri));
    return jwkSet;
  };

  const defaultMap = (c) => ({ sub: c.sub, name: c.name || c.preferred_username || c.email, email: c.email, email_verified: c.email_verified, groups: c.groups || c.roles || [], raw: c });
  const toPrincipal = mapClaims || defaultMap;

  const bearerOf = (req) => {
    const h = req.headers?.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    try { return new URL(req.url, 'http://x').searchParams.get('token'); } catch { return null; }
  };

  // roleStore 由 createServerApp 注入（掛在 adapter 上）；本地保留一份可變參照。
  const api = { roleStore: initialRoleStore };
  const principal = (req) => verifyCookie(parseCookies(req).xitto_session);

  const authed = (req) => {
    if (masterToken && bearerOf(req) === masterToken) return true; // break-glass
    const p = principal(req);
    return !!p && api.roleStore?.roleOf(p) === 'admin';
  };
  const roomAuth = (req, room, need) => {
    if (masterToken && bearerOf(req) === masterToken) return { ok: true, master: true };
    const p = principal(req);
    if (p) {
      const role = api.roleStore?.roleOf(p);
      if (role === 'admin') return { ok: true, master: true, principal: p };
      if (role) return { ok: true, principal: p, readonly: role === 'readonly' };
      // 已登入但不在名冊（封閉）→ 仍允許用房間邀請碼/成員 token 當外部訪客（下方）
    }
    const t = bearerOf(req);
    if (t) {
      for (const [mid, m] of room.members) if (m.token === t) return { ok: true, memberId: mid, member: m };
      if ((need === 'join' || need === 'read') && t === room.inviteToken) return { ok: true, invite: true };
    }
    return { ok: false };
  };

  const handle = async (req, res) => {
    let url; try { url = new URL(req.url, 'http://x'); } catch { return false; }
    const path = url.pathname;
    if (req.method !== 'GET' || !path.startsWith('/auth/')) return false;

    if (path === '/auth/login') {
      const m = await discover();
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(sha256(verifier));
      const state = b64url(randomBytes(16));
      const nonce = b64url(randomBytes(16));
      const rt = url.searchParams.get('returnTo');
      const returnTo = rt && rt.startsWith('/') ? rt : '/';
      appendCookie(res, cookieStr('xitto_tx', signCookie({ state, nonce, verifier, returnTo, exp: nowSec() + 600 }), { maxAge: 600 }));
      const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scopes.join(' '), state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });
      res.writeHead(302, { location: m.authorization_endpoint + (m.authorization_endpoint.includes('?') ? '&' : '?') + q });
      res.end(); return true;
    }

    if (path === '/auth/logout') {
      appendCookie(res, cookieStr('xitto_session', '', { maxAge: 0 }));
      res.writeHead(302, { location: '/' }); res.end(); return true;
    }

    if (path === '/auth/callback') {
      const tx = verifyCookie(parseCookies(req).xitto_tx);
      appendCookie(res, cookieStr('xitto_tx', '', { maxAge: 0 })); // 一次性，用完即清
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!tx || !code || state !== tx.state) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('invalid auth state'); return true; }
      const m = await discover();
      // 用 code 換 token（PKCE code_verifier）
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: tx.verifier });
      if (clientSecret) body.set('client_secret', clientSecret);
      let tok;
      try {
        const tr = await fetch(m.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
        if (!tr.ok) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('token exchange failed: ' + tr.status); return true; }
        tok = await tr.json();
      } catch (e) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('token endpoint error'); return true; }
      if (!tok.id_token) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('no id_token in response'); return true; }
      // 驗 id_token：簽章（JWKS）+ iss/aud/exp + nonce
      let claims;
      try {
        const set = await getJwks();
        ({ payload: claims } = await jwtVerify(tok.id_token, set, { issuer: m.issuer || issuer, audience: clientId }));
      } catch (e) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('id_token verify failed'); return true; }
      if (claims.nonce !== tx.nonce) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('nonce mismatch'); return true; }
      const p = toPrincipal(claims);
      // 封閉名冊：不在名冊/網域 → 拒絕進站（登入成功但無授權）
      const role = api.roleStore?.roleOf(p);
      if (!role) { res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1>無存取權</h1><p>你的帳號已登入但尚未獲授權，請聯絡管理員。</p>'); return true; }
      const sess = { sub: p.sub, name: p.name, email: p.email, email_verified: p.email_verified, groups: p.groups, exp: nowSec() + sessionTtl };
      appendCookie(res, cookieStr('xitto_session', signCookie(sess), { maxAge: sessionTtl }));
      res.writeHead(302, { location: tx.returnTo || '/' }); res.end(); return true;
    }
    return false;
  };

  api.authed = authed;
  api.roomAuth = roomAuth;
  api.principal = principal;
  api.handle = handle;
  return api;
}
