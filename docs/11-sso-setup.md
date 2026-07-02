# 11 · 接入你自己的 SSO（OAuth2 / OIDC）· SSO Setup Guide

> 給**部署者**的接入說明。全程**不需修改套件原始碼**——只設環境變數（或注入自訂 adapter）。
> 設計背景見 [10-sso-design.md](./10-sso-design.md)。
>
> For **deployers**: plug in your own SSO without editing package source — env vars only. Design: [10-sso-design.md](./10-sso-design.md).

## 核心觀念 / Core idea

- **OAuth2 只認人**（authentication）：IdP 證明「這是 alice@corp.com，email 已驗證」。
- **xitto 自己決定授權**（authorization）：誰是 admin / 誰能進，由 xitto 的**角色名冊**決定，與 IdP 群組無關 → 適合「IdP 不在你管理範圍」的情境。
- **純 opt-in**：不設 `XITTO_OAUTH_ISSUER` → 完全是現況（dev-token / master token / 本地全開），本地與現有部署零影響。

## 0. 先決條件 / Prerequisites

- Node ≥ 22 的部署、一個對外可達網址（例 `https://ai.example.com`）。
- IdP 支援 OAuth2 Authorization Code；OIDC（`openid` scope + id_token）最省事。
- 在 IdP 建一個 Web application，Redirect URI 設為 `https://ai.example.com/auth/callback`。

## 1. 最小設定 / Minimal setup

```bash
# 認證（設了 ISSUER 才啟用 SSO；否則維持現況）
XITTO_OAUTH_ISSUER=https://accounts.google.com      # 你的 IdP issuer
XITTO_OAUTH_CLIENT_ID=xxxxxxxx
XITTO_OAUTH_CLIENT_SECRET=xxxxxxxx
XITTO_OAUTH_REDIRECT_URI=https://ai.example.com/auth/callback
XITTO_COOKIE_SECRET="$(openssl rand -hex 32)"       # session cookie 簽章；多副本一致、勿進版控
XITTO_PUBLIC_URL=https://ai.example.com

# 授權（xitto 自管）
XITTO_ADMIN_EMAILS="you@corp.com"                    # 首任 admin，env 釘死、鎖不死
XITTO_SERVER_TOKEN="$(openssl rand -hex 24)"         # 保留當 break-glass / 機器對機器；可設空關閉
```

啟動：`npx xitto-kernel serve`。

啟用後：

- 未登入開頁面 → 302 到 `/auth/login` → IdP 登入 → 回跳 `/auth/callback` → 建立 cookie session → 進站。
- `/auth/logout` 登出。
- 命中 `XITTO_ADMIN_EMAILS` → admin（可建房 / 切模型 / 管理成員）；其餘登入者依名冊決定。
- **封閉名冊（預設）**：不在名冊、也不符網域放行者，登入成功也會被擋（顯示「請聯絡管理員」）。
- **頁面右上角顯示帳號 chip**（名字 / 角色 / 登出）；會議室會用 SSO 身份自動帶入暱稱。前端靠 `GET /v1/me` 取得登入狀態（非 SSO 模式回 `{ ssoActive:false }`，不顯示 chip）。

## 2. 各家 IdP 的 issuer / Per-provider issuer

| IdP | `XITTO_OAUTH_ISSUER` |
|---|---|
| Google | `https://accounts.google.com` |
| Azure AD / Entra | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Okta | `https://<org>.okta.com/oauth2/default` |
| Auth0 | `https://<tenant>.auth0.com/` |
| Keycloak | `https://<host>/realms/<realm>` |

issuer 填對即可——服務會打 `<issuer>/.well-known/openid-configuration` 自動取得授權 / token / JWKS 端點。

## 3. 管理員與成員 / Admins & members

`XITTO_ADMIN_EMAILS` 是**首任 admin**（env 釘死、不可經 API 改／刪，防自鎖）。其餘由 admin 在後台管理：

```
GET    /v1/admins          列角色名冊（含 pinned 標記）
POST   /v1/admins          { "email": "a@corp.com", "role": "admin|member|readonly" }
DELETE /v1/admins/<email>  撤銷
```

（以上需 operator：admin 的 cookie session，或 `XITTO_SERVER_TOKEN`。SSO 未開時也能先用 master token 預先配置名冊。）

准入策略（查不到名冊的人怎麼辦）：

- **封閉名冊（預設）**：不在名冊 → 拒絕。
- **網域放行**：設 `XITTO_ALLOWED_EMAIL_DOMAIN=corp.com` → 同網域自動成 member。

## 4. 私有 / 自架 IdP（Keycloak、ADFS…）/ Private / self-hosted OIDC

只要是標準 OIDC，issuer 指內網即可。私有化額外三項：

```bash
# 內部 CA / 自簽憑證（server-to-server 打 discovery/token/JWKS 時）——用標準方式信任，勿關驗證
NODE_EXTRA_CA_CERTS=/etc/xitto/corp-root-ca.pem

# 無 discovery 端點時，改填顯式端點
XITTO_OAUTH_AUTHZ_ENDPOINT=https://sso.corp.internal/authorize
XITTO_OAUTH_TOKEN_ENDPOINT=https://sso.corp.internal/token
XITTO_OAUTH_JWKS_URI=https://sso.corp.internal/jwks
```

> 前後通道分開：瀏覽器要能連授權端點；xitto server 要能連 token / JWKS 端點。內網 / air-gapped 皆可，只要 xitto 也在同網段。

## 5. 進階：自訂 adapter（library-embed）/ Custom adapter

要自訂 `mapClaims`（claims→身份）或授權邏輯時，改用 library-embed：自己 import kernel 起 server，
把 `oauth2Auth(...)` 傳給 `createServerApp({ auth })`。**不需修改套件原始碼**——你的入口是獨立專案。

```js
// your-server.mjs — 你的專案，import xitto-kernel 當依賴
import { createServerApp, oauth2Auth, loadModel } from 'xitto-kernel/app';

const auth = oauth2Auth({
  issuer: process.env.OIDC_ISSUER, clientId: '...', clientSecret: '...',
  redirectUri: 'https://ai.example.com/auth/callback',
  cookieSecret: process.env.XITTO_COOKIE_SECRET,
  mapClaims: (c) => ({ sub: c.sub, name: c.name, email: c.email, email_verified: c.email_verified, groups: c.groups }),
});

const { model, getApiKey, resolveModel, models } = loadModel();
createServerApp({ model, getApiKey, resolveModel, models, auth, adminEmails: ['you@corp.com'] })
  .listen(8787);
```

> `createServerApp` 會把它建立的 roleStore 注入這個 adapter（`adapter.roleStore`），授權即接上 xitto 自管名冊。

## 6. 安全檢查清單 / Security checklist

- [ ] 全站 HTTPS；session cookie 為 `HttpOnly` + `Secure` + `SameSite=Lax`（預設）。
- [ ] `XITTO_COOKIE_SECRET` 隨機長字串、多副本一致、不進版控。
- [ ] IdP Redirect URI 精確等於 `XITTO_OAUTH_REDIRECT_URI`。
- [ ] 流程含 PKCE(S256)+state+nonce（內建自動）。
- [ ] 私有 CA 用 `NODE_EXTRA_CA_CERTS`（不提供關閉 TLS 驗證的正式選項）。
- [ ] 本機開發測 SSO：非 HTTPS 下 `Secure` cookie 會被丟 → 用 `XITTO_OAUTH_INSECURE_COOKIE=1` 放寬（**僅開發**）。

## 7. 疑難排解 / Troubleshooting

| 症狀 | 檢查 |
|---|---|
| 回跳 `redirect_uri_mismatch` | IdP 設定的 URI 與 `XITTO_OAUTH_REDIRECT_URI` 不完全一致 |
| 登入後又跳登入 | 非 HTTPS 下 `Secure` cookie 被丟（用 `XITTO_OAUTH_INSECURE_COOKIE=1` 測），或多副本 `COOKIE_SECRET` 不同 |
| 登入成功卻顯示「無存取權」 | 封閉名冊：該 email 不在 `XITTO_ADMIN_EMAILS` / 名冊 / 網域放行 → 用 `/v1/admins` 加入 |
| 拿不到 email / 姓名 | scope 缺 `email`/`profile`（見 `XITTO_OAUTH_SCOPES`） |
| 私有 IdP TLS 錯誤 | 設 `NODE_EXTRA_CA_CERTS` 指到內部 CA |
