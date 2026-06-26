# 04 · 從 xitto-code 抽離的具體步驟

目標：把 xitto-code **就地**重構成 `kernel + coding pack`，行為不變、測試全綠，之後新增第二個 pack 即驗證底座成立。
這份是「每個耦合點怎麼搬」的清單，依風險由低到高。

## 耦合點總表（掃描 src/ 得出）

| # | 耦合點 | 現況位置 | 抽法 | 風險 |
|---|------|------|------|:---:|
| 1 | 工具 metadata | 各工具定義 | 幫工具加 `mutating/readOnly/sandboxable` 欄位 | 低 |
| 2 | `MUTATING`/`HEAVY_TOOLS` 常數 | `agent-factory.js:24,27` | 改讀工具 metadata + `pack.mutatingTools` | 低 |
| 3 | 工具來源 | `agent-factory.js:60` `subagent.js` | `buildTools` 收 `pack.tools()` 而非寫死 `createCodingTools` | 中 |
| 4 | read-before-edit | `agent-factory.js:158` | 搬進 `codingPack.preToolPolicy` | 中 |
| 5 | autoVerify(lint/型別) | `index.js:266,549` `util.detectVerifyCmd` | 搬進 `codingPack.verify` | 中 |
| 6 | git 整合 | `index.js` `git.js` | 成為 coding pack 的工具/指令；kernel 不認識 git | 中 |
| 7 | contextFiles 檔名 | `context.js` | `pack.contextFiles` 參數化 | 低 |
| 8 | 沙箱預設/偏 bash | `sandbox.js` `settings.js` | 機制留 kernel；預設改由 `pack.permissionPolicy` | 低 |
| 9 | 編排器肥大 | `index.js`（~800 行）| 拆出 pack 載入 + kernel 啟動，編排器變薄 | 高 |

## 逐項做法

### 1–2 · 工具 metadata 驅動（先做，零行為變化）
- 在現有工具定義補 `mutating/readOnly/sandboxable`（如 `write/edit/bash → mutating:true`、`bash → sandboxable:true`、`read/grep/ls → readOnly:true`）。
- `agent-factory.js` 把 `MUTATING.has(name)` 改成查 metadata；`READ_ONLY`（permissions.js）同理。
- **驗證**：行為與測試完全不變（只是把名單來源換成 metadata）。

### 3 · 工具來源參數化
- `buildTools({cwd, pack, ...})`：用 `pack.tools()` 取代 `createCodingTools(cwd)`。
- `subagent.js` 的子 agent 工具集同樣改由 pack 提供（子 agent 用「同 pack 的唯讀子集」）。
- coding pack 的 `tools()` 內部仍呼叫 `createCodingTools` —— 只是包裝進 pack，**行為不變**。

### 4 · read-before-edit → pack.preToolPolicy
- 把 `agent-factory.js` 那段「edit/write 已存在未讀 → 擋」搬成 `codingPack.preToolPolicy.check`。
- kernel 的守衛鏈第 3 格呼叫它。kernel 從此不認識「edit」「檔案」。
- `readFiles` 這個已讀集合：改放進 KernelServices 或 pack 的閉包狀態。

### 5 · autoVerify → pack.verify
- `detectVerifyCmd`（找 tsc/eslint）+ `runAutoVerify` 的回灌循環：
  - 回灌**機制**（最多 N 輪、失敗餵回模型）留 kernel（通用）。
  - 「跑什麼指令、何時跑」變成 `codingPack.verify.run / shouldRun`。

### 6 · git → coding pack 的能力
- `/diff` `/commit` `/push` 與 `git.js`：成為 coding pack 提供的指令與工具。
- kernel 只提供「pack 可註冊自訂指令」的機制（已有 `commands.js`），git 變成 coding pack 註冊的東西。
- 狀態列的 git 分支顯示：改成 pack 可選提供的「狀態列貢獻者」。

### 7 · contextFiles
- `context.js` 的 `['XITTO.md','CLAUDE.md','AGENTS.md','.xitto-code.md']` 改成 `pack.contextFiles`。

### 8 · 沙箱
- `sandbox.js`/`permissions.js` 機制不動（已是領域無關）。
- 只把「預設啟用與否、allowWritePrefixes」改成可由 `pack.permissionPolicy` 提供預設，使用者 `settings.json` 仍可覆蓋。

### 9 · 編排器瘦身（最後做、風險最高）
- `index.js` 拆成：`loadPack()` → `createKernel(pack, config)` → `mountTui()`。
- verify/git/read-before-edit 都已搬走後，`index.js` 只剩「載 pack、起 kernel、接 TUI 事件」。

## 抽離順序（建議）

```
第一波（零行為變化、低風險）：1 → 2 → 7 → 8
第二波（搬邏輯、靠測試守）：    3 → 4 → 5 → 6
第三波（結構重整）：           9
驗收：新增一個非編碼 pack（見 05），同一 kernel 跑起來 → 底座成立
```

## 怎麼證明抽對了

- **回歸**：每一波後 xitto-code 的 287 測試必須全綠（coding pack 行為 == 原本）。
- **正交**：新增第二、三個 pack（data-query / notes）**不需要改 kernel 任何一行**。做得到 → 抽象成功；做不到 → 哪裡還有領域洩漏到 kernel，補抽。（已驗證：見 `src/packs/`）
