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

// 破玻璃管理員登入頁（隱藏後門，不從任何 UI 連結）：純內聯、無外部依賴，殘缺環境也能顯示。
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const adminLoginHtml = ({ error = '', returnTo = '/settings' } = {}) => `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>管理員登入</title><meta name="robots" content="noindex,nofollow"><style>
:root{--bg:#0f1115;--card:#191c23;--inset:#12141a;--line:#2a2e37;--fg:#e6e8ee;--dim:#9aa0ad;--accent:#5b63e6;--err:#e5484d}
@media (prefers-color-scheme: light){:root{--bg:#f5f6f8;--card:#fff;--inset:#f0f1f4;--line:#d9dce2;--fg:#1a1d24;--dim:#6b7280}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Noto Sans TC",sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;width:min(400px,96vw);padding:26px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}.brand svg{width:28px;height:28px}.brand h1{font-size:19px;margin:0}
.sub{color:var(--dim);font-size:13px;margin:0 0 18px}
label{display:block;font-size:13px;color:var(--dim);margin:0 0 5px}
input{width:100%;background:var(--inset);color:var(--fg);border:1px solid var(--line);border-radius:9px;padding:10px 11px;font:inherit}
input:focus{outline:none;border-color:var(--accent)}
button{background:var(--accent);color:#fff;border:0;border-radius:9px;padding:11px 16px;font:inherit;font-weight:600;cursor:pointer;width:100%;margin-top:18px}
.err{margin-top:14px;font-size:13px;padding:9px 12px;border-radius:9px;color:var(--err);background:color-mix(in srgb,var(--err) 12%,transparent);border:1px solid color-mix(in srgb,var(--err) 35%,var(--line))}
.hint{color:var(--dim);font-size:12px;margin-top:14px}
</style></head><body><div class="card">
<div class="brand"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#5b63e6"/><g fill="#fff"><path d="M11 21l8-8 1.6 1.6-8 8z" opacity=".95"/><path d="M20 9l.7 1.8L22.5 11.5l-1.8.7L20 14l-.7-1.8L17.5 11.5l1.8-.7z"/></g></svg><h1>管理員登入</h1></div>
<p class="sub">破玻璃入口：以伺服器 token 登入，管理模型設定（provider）。</p>
<form method="POST" action="/admin/login" autocomplete="off">
<input type="hidden" name="returnTo" value="${escHtml(returnTo)}">
<label>伺服器 Token</label>
<input type="password" name="token" placeholder="XITTO_SERVER_TOKEN" autofocus>
<button type="submit">登入</button>
</form>
${error ? `<div class="err">${escHtml(error)}</div>` : ''}
<p class="hint">此頁不對外連結，僅供 operator 應急。登入後可前往 <code>/settings</code>。</p>
</div></body></html>`;

const parseCookies = (req) => Object.fromEntries(
  String(req.headers?.cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => {
    const i = c.indexOf('='); return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)];
  }),
);

export function oauth2Auth(config = {}) {
  const {
    issuer, authorizationEndpoint, tokenEndpoint, jwksUri, jwks,
    userinfoEndpoint, userinfoTokenIn = 'query',    // 非 OIDC（無 id_token）→ 用 access_token 打 userinfo/profile 端點取身份
    usePkce = true,                                  // 部分 CAS/OAuth2 不支援 PKCE，可關
    tokenParamsIn = 'body',                          // 換 token 的參數位置：'body'（標準）或 'query'（部分 CAS 規範：所有參數拼在 url 上）
    logoutEndpoint, logoutReturnParam = 'returnurl', postLogoutRedirect,  // IdP 端登出（登出後導回 postLogoutRedirect）
    clientId, clientSecret, redirectUri,
    scopes = ['openid', 'email', 'profile'],
    cookieSecret, sessionTtl = 8 * 3600, masterToken = '',
    roleStore: initialRoleStore = null, mapClaims, secureCookie = true,
  } = config;
  if (!cookieSecret) throw new Error('oauth2Auth 需要 cookieSecret（設 XITTO_COOKIE_SECRET）');
  if (!clientId || !redirectUri) throw new Error('oauth2Auth 需要 clientId 與 redirectUri');
  // 認身份的來源需其一：issuer（OIDC discovery）／顯式 authorization+token+（jwks｜userinfo）。
  if (!issuer && !(authorizationEndpoint && tokenEndpoint && (jwksUri || jwks || userinfoEndpoint))) {
    throw new Error('oauth2Auth 需要 issuer（走 discovery）或顯式端點 authorization/token/（jwks 或 userinfo）');
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
    if (authorizationEndpoint && tokenEndpoint && (jwksUri || jwks || userinfoEndpoint)) {
      meta = { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, jwks_uri: jwksUri, userinfo_endpoint: userinfoEndpoint, issuer };
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

  // 兼容兩種身份來源：OIDC id_token（扁平 claims）與 OAuth2 userinfo/profile（常見嵌套 attributes，多見於企業 CAS）。
  // 自訂映射用 mapClaims 覆蓋；預設盡量從兩種形狀取到 email（roleStore 以 email 判角色）。
  const defaultMap = (c) => {
    const a = (c && typeof c.attributes === 'object' && c.attributes) ? c.attributes : c;
    return {
      sub: String(c.sub ?? c.id ?? a.account_no ?? a.work_no ?? a.email ?? a.ad_account ?? ''),
      name: a.user_name || c.name || a.name || c.preferred_username || a.email || c.email,
      email: a.email || c.email,
      email_verified: c.email_verified ?? a.email_verified,
      adAccount: a.ad_account,
      workNo: a.work_no || a.account_no,
      groups: a.groups || a.roles || c.groups || c.roles || [],
      raw: c,
    };
  };
  const toPrincipal = mapClaims || defaultMap;

  const bearerOf = (req) => {
    const h = req.headers?.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    try { return new URL(req.url, 'http://x').searchParams.get('token'); } catch { return null; }
  };

  // roleStore 由 createServerApp 注入（掛在 adapter 上）；本地保留一份可變參照。
  const api = { roleStore: initialRoleStore };
  const principal = (req) => verifyCookie(parseCookies(req).xitto_session);

  // 破玻璃管理員 session（隱藏後門 /admin/login 發出）：以 master token 為憑證換得的簽章 cookie。
  // 用途——IdP 掛掉／operator 不在 SSO 名冊時，仍能登入管 provider；憑證不落網址列（有別於 ?token=）。
  // masterToken 為空（XITTO_SERVER_TOKEN=""）即關閉 break-glass → 後門一併停用（cookie 也不採信）。
  const adminSession = (req) => {
    if (!masterToken) return false;
    const c = verifyCookie(parseCookies(req).xitto_admin);
    return !!(c && c.admin);
  };
  // 定長比較 master token，避免時序側信道；長度不同即 false。
  const tokenMatch = (a, b) => {
    if (!a || !b) return false;
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  };

  // 登入即放行：只要 SSO 登入且在名冊有角色（admin/member/readonly）或持 master token，即算 authed。
  // → 一般使用者登入後進站／用會議室不再被 401（授權細分交給 roomAuth 與 authedAdmin）。
  const authed = (req) => {
    if (masterToken && bearerOf(req) === masterToken) return true; // break-glass
    if (adminSession(req)) return true; // 破玻璃 admin cookie（也是 admin，當然 authed）
    const p = principal(req);
    return !!p && !!api.roleStore?.roleOf(p);
  };
  // 提權敏感操作（改名冊角色、改 provider/API Key 設定）仍限 admin，避免 member 自我提權或改壞服務。
  const authedAdmin = (req) => {
    if (masterToken && bearerOf(req) === masterToken) return true; // break-glass
    if (adminSession(req)) return true; // 破玻璃 admin cookie
    const p = principal(req);
    return !!p && api.roleStore?.roleOf(p) === 'admin';
  };
  const roomAuth = (req, room, need) => {
    if (masterToken && bearerOf(req) === masterToken) return { ok: true, master: true };
    const t = bearerOf(req);
    const p = principal(req);
    const role = p ? api.roleStore?.roleOf(p) : null;
    // 成員 token 優先：綁定 memberId（發言者身分由 token 決定、不冒名）。SSO 已登入者也需靠此定位「我是哪個成員」，
    // 否則 say 的 memberId 取不到 → 誤報「請先加入房間」。同時帶入其角色 → 唯讀房把關（admin 可寫、其餘唯讀）。
    if (t) {
      for (const [mid, m] of room.members) {
        if (m.token === t) return { ok: true, memberId: mid, member: m, principal: p || undefined, master: role === 'admin', readonly: role === 'readonly' };
      }
    }
    // 已登入且在名冊（或開放模式）→ 授權放行（尚未 join：可讀/可操作；say 仍需先 join 才有 memberId）。
    if (p && role) {
      if (role === 'admin') return { ok: true, master: true, principal: p };
      return { ok: true, principal: p, readonly: role === 'readonly' };
    }
    // 外部訪客：邀請碼可讀 / 可 join。
    if (t && (need === 'join' || need === 'read') && t === room.inviteToken) return { ok: true, invite: true };
    return { ok: false };
  };

  const handle = async (req, res) => {
    let url; try { url = new URL(req.url, 'http://x'); } catch { return false; }
    const path = url.pathname;

    // 破玻璃管理員後門（隱藏路徑，不從 UI 連結）：masterToken 為空即整條停用 → 回 false 讓它落到 404。
    if (masterToken && path.startsWith('/admin/')) {
      const safeReturn = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')) ? v : '/settings';
      if (path === '/admin/login' && req.method === 'GET') {
        const returnTo = safeReturn(url.searchParams.get('returnTo'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        res.end(adminLoginHtml({ returnTo })); return true;
      }
      if (path === '/admin/login' && req.method === 'POST') {
        // 讀表單（限縮長度、只吃 x-www-form-urlencoded）→ 定長比對 token → 發簽章 admin cookie。
        const raw = await new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy(); }); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
        const form = new URLSearchParams(raw);
        const returnTo = safeReturn(form.get('returnTo'));
        if (!tokenMatch(form.get('token'), masterToken)) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(adminLoginHtml({ error: 'Token 不正確。', returnTo })); return true;
        }
        const ttl = sessionTtl;
        appendCookie(res, cookieStr('xitto_admin', signCookie({ admin: true, exp: nowSec() + ttl }), { maxAge: ttl }));
        res.writeHead(302, { location: returnTo }); res.end(); return true;
      }
      if (path === '/admin/logout') {
        appendCookie(res, cookieStr('xitto_admin', '', { maxAge: 0 }));
        res.writeHead(302, { location: '/admin/login' }); res.end(); return true;
      }
    }

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
      const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scopes.join(' '), state, nonce });
      if (usePkce) { q.set('code_challenge', challenge); q.set('code_challenge_method', 'S256'); } // 部分 CAS/OAuth2 不支援 PKCE → 可關
      res.writeHead(302, { location: m.authorization_endpoint + (m.authorization_endpoint.includes('?') ? '&' : '?') + q });
      res.end(); return true;
    }

    if (path === '/auth/logout') {
      appendCookie(res, cookieStr('xitto_session', '', { maxAge: 0 }));
      // 設了 logoutEndpoint → 連 IdP 一起登出（單點登出），登出後導回 postLogoutRedirect（預設 redirectUri 的網域根）。
      if (logoutEndpoint) {
        const back = postLogoutRedirect || (() => { try { return new URL(redirectUri).origin + '/'; } catch { return '/'; } })();
        const loc = logoutEndpoint + (logoutEndpoint.includes('?') ? '&' : '?') + encodeURIComponent(logoutReturnParam) + '=' + encodeURIComponent(back);
        res.writeHead(302, { location: loc }); res.end(); return true;
      }
      res.writeHead(302, { location: '/' }); res.end(); return true;
    }

    if (path === '/auth/callback') {
      const tx = verifyCookie(parseCookies(req).xitto_tx);
      appendCookie(res, cookieStr('xitto_tx', '', { maxAge: 0 })); // 一次性，用完即清
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!tx || !code || state !== tx.state) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('invalid auth state'); return true; }
      const m = await discover();
      // 用 code 換 token（PKCE 時帶 code_verifier）
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId });
      if (usePkce) body.set('code_verifier', tx.verifier);
      if (clientSecret) body.set('client_secret', clientSecret);
      let tok;
      try {
        // tokenParamsIn='query'（部分 CAS）：參數拼在 url 上、body 空；否則標準走 form-urlencoded body。
        const inQuery = tokenParamsIn === 'query';
        const tokenUrl = inQuery ? m.token_endpoint + (m.token_endpoint.includes('?') ? '&' : '?') + body.toString() : m.token_endpoint;
        const tr = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, ...(inQuery ? {} : { body }) });
        if (!tr.ok) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('token exchange failed: ' + tr.status); return true; }
        tok = await tr.json();
      } catch (e) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('token endpoint error'); return true; }
      // 身份來源分叉：有 id_token 且能取 JWKS → OIDC 驗簽（含 nonce）；否則 → OAuth2 userinfo/profile 端點取身份（如企業 CAS）。
      const uiEndpoint = m.userinfo_endpoint || userinfoEndpoint;
      let claims;
      if (tok.id_token && (jwks || m.jwks_uri)) {
        try {
          const set = await getJwks();
          ({ payload: claims } = await jwtVerify(tok.id_token, set, { issuer: m.issuer || issuer, audience: clientId }));
        } catch (e) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('id_token verify failed'); return true; }
        if (claims.nonce !== tx.nonce) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('nonce mismatch'); return true; }
      } else if (uiEndpoint && tok.access_token) {
        // 非 OIDC：拿 access_token 打 userinfo/profile（state 已防 CSRF；access_token 用完即棄，不作會話憑證）。
        try {
          const inHeader = userinfoTokenIn === 'header';
          const uurl = inHeader ? uiEndpoint : uiEndpoint + (uiEndpoint.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(tok.access_token);
          const ur = await fetch(uurl, { headers: { accept: 'application/json', ...(inHeader ? { authorization: 'Bearer ' + tok.access_token } : {}) } });
          if (!ur.ok) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('userinfo failed: ' + ur.status); return true; }
          claims = await ur.json();
        } catch (e) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('userinfo endpoint error'); return true; }
      } else {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('no id_token and no userinfo endpoint'); return true;
      }
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
  api.authedAdmin = authedAdmin;
  api.roomAuth = roomAuth;
  api.principal = principal;
  api.handle = handle;
  return api;
}
