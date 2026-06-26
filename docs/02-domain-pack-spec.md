# 02 · DomainPack 介面規格

一個 DomainPack 是一個純資料物件（含少量函數）。kernel 啟動時載入一個 pack，把它的欄位接到對應插槽。

## 完整介面（JSDoc 形式；實際型別定義見 [`src/types.js`](../src/types.js)）

```js
/**
 * @typedef {Object} DomainPack
 *
 * ── 必填 ──────────────────────────────────────────────
 * @property {string} name                領域識別名（'coding' / 'data-query' / 'notes'）
 * @property {() => Tool[]} tools          建立該領域的工具集（見下方 Tool）。
 *                                         收 KernelServices 之外只需 cwd/設定，回傳工具陣列。
 * @property {string} systemPrompt         領域行為準則，注入 system prompt。
 *
 * ── 選填（不給就用 kernel 的安全預設）─────────────────
 * @property {string[]} [contextFiles]     由近而遠尋找的慣例檔名（編碼=['CLAUDE.md','AGENTS.md']）。
 *                                         預設 []（不載入任何專案規範檔）。
 * @property {string[]} [mutatingTools]    哪些工具算「會改動狀態」，供 plan 模式與熔斷判斷。
 *                                         預設：tools 中標了 `mutating:true` 的那些（見 Tool.mutating）。
 * @property {VerifyPolicy} [verify]       每輪收尾的領域自我驗收。預設 undefined（不驗收）。
 * @property {PreToolPolicy} [preToolPolicy] 工具執行前的領域守衛。預設 undefined（無額外守衛）。
 * @property {PermissionPolicy} [permissionPolicy] 該領域的權限/沙箱預設。預設 kernel 全域預設。
 * @property {string} [memoryGuide]        要不要、何時主動存記憶的領域提示。預設 kernel 通用版。
 */
```

### Tool（kernel 的通用工具原語）

kernel 不在乎工具做什麼，只在乎這個形狀。**這就是 xitto-code 既有的工具形狀**，所以任何現有工具不改即可用：

```js
/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {string} label              UI 顯示用短名
 * @property {string} description        給模型看的用途說明
 * @property {object} parameters         JSON Schema
 * @property {(id, params, signal?, onUpdate?, ctx?) => Promise<ToolResult>} execute
 * @property {boolean} [mutating]        是否會改動狀態（預設 false）。kernel 據此自動推導 mutatingTools。
 * @property {boolean} [readOnly]        是否唯讀（唯讀工具 kernel 自動放行、不問權限）。
 * @property {boolean} [sandboxable]     執行是否可被沙箱包裹（如走 shell 的工具）。預設 false。
 */
```

> 關鍵：把「這工具會不會改動 / 是否唯讀 / 能否沙箱」變成**工具自帶的 metadata**，
> kernel 就不必再寫死 `MUTATING = {'write','edit','bash'}` 這種領域名單（見 04 的改點）。

### VerifyPolicy（領域自我驗收）

```js
/**
 * @typedef {Object} VerifyPolicy
 * @property {(ctx: VerifyContext) => Promise<{ok: boolean, output?: string}>} run
 *   回 ok:false 時 kernel 把 output 回灌給 agent 要求修正（沿用 xitto-code 的 runAutoVerify 機制，最多 N 輪）。
 * @property {(ctx) => boolean} [shouldRun]   是否該跑（編碼：本輪有改檔才跑）。預設 turnModified。
 * @property {number} [maxRounds]             回灌修正上限。預設 2。
 */
```

- 編碼：`run` = 跑 `detectVerifyCmd`（tsc/eslint），`shouldRun` = 本輪有 write/edit。
- 文件寫作：`run` = 連結/拼字檢查。
- 資料查詢：通常 `verify` 不給（查詢無「驗收」概念）。

### PreToolPolicy（工具前領域守衛）

```js
/**
 * @typedef {Object} PreToolPolicy
 * @property {(ctx: PreToolContext, kernel: KernelServices) => PolicyDecision} check
 *   回 undefined = 放行；回 { block:true, reason } = 擋下並把 reason 餵回模型。
 */
```

- 編碼：實作 **read-before-edit**——「編輯已存在但未讀過的檔 → 擋下要求先 read」。
  （這正是目前寫死在 `agent-factory.js` 的邏輯，搬成 pack 後 kernel 不再認識「edit/檔案」概念。）
- 其他領域：可換成自己的守衛（如客服 pack：「退款前必須先查到訂單」）或不給。

### PermissionPolicy（權限/沙箱預設）

```js
/**
 * @typedef {Object} PermissionPolicy
 * @property {'default'|'acceptEdits'|'plan'} [defaultMode]
 * @property {boolean|object} [sandbox]        同 xitto-code settings.json 的 permissions.sandbox
 * @property {string[]} [allow]                預設放行的工具/命令簽章
 * @property {string[]} [deny]                 預設禁止
 */
```

kernel 的 `permissions.js`/`sandbox.js` 機制完全不動，只是「預設值」改成可由 pack 提供、再被使用者的 `settings.json` 覆蓋。

## 必填/選填總表

| 欄位 | 必填 | 不給時 |
|------|:----:|------|
| `name` | ✅ | — |
| `tools` | ✅ | — |
| `systemPrompt` | ✅ | — |
| `contextFiles` | ⬜ | 不載入專案規範檔 |
| `mutatingTools` | ⬜ | 從 `tool.mutating` 自動推導 |
| `verify` | ⬜ | 不做自我驗收 |
| `preToolPolicy` | ⬜ | 無領域守衛 |
| `permissionPolicy` | ⬜ | kernel 全域預設 |
| `memoryGuide` | ⬜ | kernel 通用記憶提示 |

> **最小 pack 只需三個必填欄位**就能跑起來——這是「底座好不好用」的關鍵指標：
> 新領域的入門成本 = 寫工具 + 一段 prompt + 一個名字。
