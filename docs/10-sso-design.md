# 10 · SSO 接入設計（OAuth2 / OIDC）

> 狀態：設計已定稿，實作分階段進行。本文件為實作依據與驗收標準。
> Status: design finalized, implemented in stages. This doc is the implementation spec & acceptance criteria.

## 0. 定位 / Positioning

**OAuth2 只負責「認證／認人」；「授權／誰是 admin、誰能進」由 xitto 自管的角色名冊決定。**
純 opt-in——不設 `XITTO_OAUTH_ISSUER` 就等同現況，本地與現有部署零影響。

**OAuth2 handles _authentication_ only (who you are). _Authorization_ (who is admin, who may enter)
is owned by xitto's own role store**, because the deployer does not control the IdP.
Fully opt-in: without `XITTO_OAUTH_ISSUER` set, behavior is byte-for-byte identical to today.

## 1. 鎖定的決策 / Locked decisions

| 決策 | 結論 |
|---|---|
| 支援協定 | **只 OAuth2 / OIDC**（Authorization Code + PKCE）。不做 trusted-header、SAML、LDAP |
| 授權來源 | **xitto 自管角色名冊**（IdP 不在管理範圍內） |
| 存取模式 | **封閉名冊**（預設）：不在名冊／白名單者，登入成功也擋在門外 |
| 首任 admin | `XITTO_ADMIN_EMAILS` 用環境變數釘死，鎖不死自己 |
| 應急後門 | 保留 `XITTO_SERVER_TOKEN` 當 break-glass / 機器對機器；可設空關閉 |
| 身份 key | **email**（需 `email_verified`）；`sub` 僅去重防換信箱 |
| Session | httpOnly + Secure cookie（簽章 JWT，無 server store）、短 TTL（預設 8h） |
| 向後相容 | 沒設 `XITTO_OAUTH_ISSUER` → 認證行為與現在逐位元組一致 |

## 2. 認證流程 / Auth flow

```
未登入 → GET /auth/login   （PKCE S256 + state + nonce，302 轉 IdP）
       → GET /auth/callback（驗 state；用 code 換 token；對 JWKS 驗 id_token 的 iss/aud/exp/nonce）
       → 簽 cookie session  → 進站
GET /auth/logout            清 cookie
```

- 給了 `issuer` → 走 `/.well-known/openid-configuration` discovery。
- 私有 IdP：可改**顯式端點**（`authorizationEndpoint`/`tokenEndpoint`/`jwksUri`）+ **靜態／離線 JWKS** + `NODE_EXTRA_CA_CERTS` 信任私有 CA。

## 3. 身份模型 / Principal

```
Principal { sub, name, email, email_verified, raw }
```

## 4. 授權：xitto 角色名冊 / Authorization: xitto-owned role store

持久化於 `baseDir/auth/roles.json`（與 rooms/sessions 同掛載卷，契合容器無狀態化）。

`roleOf(principal)` 判定順序：

```
1. 帶對 master token（break-glass）        → admin
2. email ∈ XITTO_ADMIN_EMAILS（env 釘死）   → admin      ← 永遠鎖不死
3. roleStore 命中                           → admin | member | readonly
4. 命中 XITTO_ALLOWED_EMAIL_DOMAIN（選填）  → member
5. 皆無                                      → 封閉模式：拒絕（提示「請聯絡管理員」）
```

`authorize(principal, action, ctx)` 依 role 回 `{ allow, master, readonly, workspaces }`，
接進現有 `roomAuth`（`server.js` `roomAuth`）與 `/v1/*` 閘門（`server.js` `authed`）。

## 5. admin 登入與成員管理 / Admin login & member management

- **admin 沒有獨立登入**：同一個 `/auth/login`，差別只在 `roleOf` 命中 admin。
- **成員管理後台（operator only）**：

```
GET    /v1/admins          列角色名冊
POST   /v1/admins          { email, role }  授予／調整
DELETE /v1/admins/:email   撤銷
GET    /v1/users           看誰登入過（profile 快取）→ 挑人提權
```

`XITTO_ADMIN_EMAILS` 的人是 env 釘死、名冊不可刪（防自鎖）。

## 6. 設定面（部署者零改碼）/ Configuration (zero source edits)

```bash
# 認證（設了 ISSUER 才啟用整套 SSO）
XITTO_OAUTH_ISSUER=https://sso.corp.internal/realms/company
XITTO_OAUTH_CLIENT_ID=...        XITTO_OAUTH_CLIENT_SECRET=...
XITTO_OAUTH_REDIRECT_URI=https://ai.corp/auth/callback
XITTO_OAUTH_SCOPES="openid email profile"        # 選填
XITTO_COOKIE_SECRET=<openssl rand -hex 32>
XITTO_SESSION_TTL=8h                             # 選填

# 私有 IdP（選填）
XITTO_OAUTH_JWKS_URI=...   XITTO_OAUTH_AUTHZ_ENDPOINT=...   XITTO_OAUTH_TOKEN_ENDPOINT=...
NODE_EXTRA_CA_CERTS=/etc/xitto/corp-ca.pem

# 授權（xitto 自管）
XITTO_ADMIN_EMAILS="you@corp.com"                # 首任 admin，釘死
XITTO_ALLOWED_EMAIL_DOMAIN=corp.com              # 選填；不設=純封閉名冊
XITTO_SERVER_TOKEN=<長隨機>                        # break-glass / M2M，可空關閉
```

進階客製走 library-embed：自己 import `oauth2Auth` 傳給 `createServerApp({ auth })`（自訂 `mapClaims` 等），仍限 OAuth2。見 [11-sso-setup.md](./11-sso-setup.md) §5。

## 7. 程式接入點（套件內一次性改動；deployer 永不碰原始碼）/ Integration points

1. `createServerApp` 新增可選 `auth` adapter；現有 token 邏輯（`authed`/`roomAuth`）包成 `defaultAuth`——無 adapter 即回退，零行為變化。
2. 路由最前面先問 `adapter.handle(req,res)` 消化 `/auth/*`。
3. 內建 `oauth2Auth(config)` + `roleStore`（讀寫 `roles.json`）。
4. `startServer` 偵測 `XITTO_OAUTH_ISSUER` 自動掛載。
5. 前端 `index.html`/`chat.html`/`room.html`：cookie session 下自動帶憑證；未登入頁面 302 到 `/auth/login`；`__SERVER_TOKEN__` 注入退為 fallback。
6. 會議室 `join` 用 principal 真實身份取代匿名 name（順帶補齊多人 @ai 的 L2 身份，見 `docs/room` 相關）。

### Adapter 介面 / Adapter interface

```
auth = {
  handle?(req, res): Promise<boolean>            // 擁有 /auth/*；處理了回 true。預設無
  authed(req): boolean                            // operator / master 閘門
  roomAuth(req, room, need): { ok, master?, memberId?, member?, invite? }
  principal?(req): Principal | null               // 給顯示 / 房間 join 用；預設 null
}
```

## 8. 安全要求（驗收硬條件）/ Security requirements

- PKCE（S256）+ state + nonce 全程。
- id_token 驗簽 + `iss`/`aud`/`exp`/`nonce` 校驗。
- cookie `httpOnly` + `Secure` + `SameSite=Lax`。
- `email_verified` 必查。
- 封閉模式預設拒絕陌生人。
- 私有 CA 用 `NODE_EXTRA_CA_CERTS`；**不提供關閉 TLS 驗證的正式選項**。

## 9. 非目標 / Non-goals

反向代理信任標頭、SAML / LDAP / 自研協定、IdP 端用戶 CRUD、即時撤銷（靠短 TTL 收斂）。

## 10. 測試 / Tests

- 🔒 **「未設 OAuth 環境變數 → 認證與現況逐位元組一致」**（相容性守門，最先做）。
- code-flow（mock IdP）、state/nonce 校驗、cookie 簽發／驗證。
- `roleOf` 五級判定、`XITTO_ADMIN_EMAILS` 不可刪、封閉模式拒絕。
- `/v1/admins` CRUD 需 operator。

## 11. 實作階段 / Implementation stages

- **S1（零風險骨架）✅**：`createServerApp` 抽出 `auth` seam + `defaultAuth`（現有邏輯原樣封裝）+ 相容性守門測試。不接任何 IdP。
- **S2 ✅**：`createRoleStore`（`roles.json` 讀寫）+ `roleOf` 五級判定 + `/v1/admins` API。
- **S3 ✅**：`oauth2Auth`（discovery / 顯式端點 / JWKS / PKCE+state+nonce / cookie session）+ `startServer` 環境變數掛載 + `jose` 依賴。
- **S4 ✅**：前端未登入導向 `/auth/login`、SSO 下不注入 master token、會議室 join 綁 principal 身份、使用指南 [11-sso-setup.md](./11-sso-setup.md)。

實作對應測試：`test/server-rooms.test.js`（S1/S2）、`test/server-sso-oauth2.test.js`（S3/S4，mock IdP 端到端）。
