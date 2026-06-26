# 03 · Kernel 契約

兩個方向的契約：**kernel 對外提供什麼服務給 pack/工具用**，以及 **kernel 怎麼消費 pack**。

## A. KernelServices — kernel 提供給 pack 與工具的服務

pack 的 `preToolPolicy.check` 與工具的 `execute(... ctx)` 可拿到這組服務（依賴注入，便於測試）。
這些都是 xitto-code 已有、領域無關的能力：

```js
/**
 * @typedef {Object} KernelServices
 * @property {string} cwd
 * @property {Memory}  memory      // memory_save / memory_list（memory.js）
 * @property {Spawn}   spawn        // 派唯讀子 agent 做聚焦調查（subagent.js）
 * @property {Ask}     ask          // 向使用者提問（方向鍵選單 / 純文字）
 * @property {Notify}  notify       // 推訊息到 TUI transcript
 * @property {Model}   model        // 當前模型（provider 無關）
 * @property {(messages) => Promise<CompactInfo>} compact   // 手動觸發壓縮
 * @property {Sandbox} sandbox      // 查詢沙箱狀態 / 包裹命令（sandbox.js）
 */
```

**設計重點**：pack 不直接碰 provider、TUI 內部、session 檔——只透過 KernelServices。
這讓 pack 可在 fake kernel 下單測（xitto-code 已用這套依賴注入風格，見 `createAgent(deps)`）。

## B. kernel 怎麼消費 pack（接線點）

kernel 啟動時把 pack 的欄位接到既有插槽。對照 xitto-code 現況：

| pack 欄位 | kernel 接到哪 | xitto-code 對應現況 |
|------|------|------|
| `tools()` | 工具註冊表 | `agent-factory.js buildTools()` 目前寫死 `createCodingTools` |
| `systemPrompt` | system prompt 組裝 | `index.js` 的 `base.prompt` |
| `contextFiles` | 專案規範載入 | `context.js` 目前寫死 CLAUDE.md/AGENTS.md/XITTO.md |
| `mutatingTools` | plan 守衛 + 熔斷 | `agent-factory.js` 的 `MUTATING`/`HEAVY_TOOLS` 常數 |
| `preToolPolicy` | `beforeToolCall` 守衛鏈 | `agent-factory.js` 寫死的 read-before-edit |
| `verify` | 回合收尾 | `index.js runAutoVerify()` + `detectVerifyCmd` |
| `permissionPolicy` | 權限預設 | `settings.js` 的預設值 |

## C. beforeToolCall 守衛鏈（kernel 固定順序，pack 只插一格）

kernel 維持這個固定順序（安全性靠順序保證），pack 只能在第 3 格插領域守衛：

```
1. planMode && pack.mutatingTools.has(name)        → 擋（kernel）
2. 上下文熔斷（kernel）
3. pack.preToolPolicy?.check(ctx, services)         → 領域守衛（PACK 的唯一插槽）
4. PreToolUse hooks（kernel，使用者 settings.json）
5. permissionHook（kernel）：deny → 沙箱違規 → 危險命令 → 確認/白名單
6. 通過 → 執行；sandboxable 工具且沙箱開 → Seatbelt 包裹（kernel）
```

> pack **不能**重排或跳過 4/5/6——權限、沙箱、危險命令偵測是 kernel 的不可繞過保證。
> pack 只能「額外擋更多」（第 3 格），不能「放行 kernel 想擋的」。這是安全模型的核心約束。

## D. 工具 metadata 驅動（取代寫死名單）

kernel 不再有 `MUTATING = {'write','edit','bash'}` 這種領域常數，改成讀工具自帶的 metadata：

```js
// kernel 內部（領域無關）
const isMutating  = (t) => t.mutating === true;
const isReadOnly  = (t) => t.readOnly === true;
const canSandbox  = (t) => t.sandboxable === true;

// mutatingTools：pack 顯式給就用，否則從工具 metadata 推導
const mutating = pack.mutatingTools ?? pack.tools().filter(isMutating).map(t => t.name);
```

好處：加新工具時，「它會不會改動 / 該不該沙箱」由工具自己宣告，kernel 與其他 pack 都不用改。

## E. 不變式（kernel 對任何 pack 的保證）

1. **權限不可繞過**：唯讀工具自動放行；其餘一律過 permissionHook。pack 無法關掉這層。
2. **沙箱由 kernel 套用**：pack 宣告 `sandboxable` 工具，是否真包裹由 kernel + 使用者設定決定。
3. **記憶/壓縮/session 自動運作**：pack 不需關心上下文會不會爆、怎麼存檔。
4. **provider 無關**：pack 不寫任何 provider 專屬程式碼；換模型不影響 pack。
5. **可中斷**：任何工具執行中 Esc/Ctrl+C 都能中止（kernel 的 abort 機制）。
