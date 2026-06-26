# 01 · 架構：kernel + DomainPack

## 分層

```
┌──────────────────────────────────────────────────────────────┐
│  入口 / 編排 (app)                                              │
│  解析 CLI、載入設定、選 DomainPack、掛載 TUI、跑互動循環          │
├──────────────────────────────────────────────────────────────┤
│  DomainPack（可插拔，一個領域一份）                              │
│  tools · systemPrompt · contextFiles · mutatingTools           │
│  verify? · preToolPolicy? · permissionPolicy?                  │
├──────────────────────────────────────────────────────────────┤
│  Kernel（領域無關，固定）                                        │
│  ┌────────────┬──────────────┬───────────────┬──────────────┐ │
│  │ agent loop │ provider 抽象 │ 工具註冊/執行  │ 權限/沙箱     │ │
│  │ 記憶        │ 上下文壓縮    │ session 持久化 │ 子 agent      │ │
│  │ skills      │ commands      │ hooks          │ MCP           │ │
│  │ TUI(串流)   │ 重試/think 過濾                                │ │
│  └────────────┴──────────────┴───────────────┴──────────────┘ │
├──────────────────────────────────────────────────────────────┤
│  Provider 層（pi-ai）：anthropic / openai / google / …          │
└──────────────────────────────────────────────────────────────┘
```

**規則**：kernel 不認識任何領域概念（不知道什麼是「檔案」「commit」「SQL」）。
所有領域知識都在 DomainPack 裡。kernel 只認得「工具」「訊息」「權限決策」「記憶條目」這些通用原語。

## Kernel 模組清單（從 xitto-code 哪些檔來）

這些檔在 xitto-code 已經是領域無關的，直接構成 kernel：

| kernel 能力 | xitto-code 來源 | 是否需改 |
|------|------|------|
| agent 循環 | `agent-loop.js` | 移除寫死的工具名集合（見 04）|
| provider 設定 | `config.js` | 無 |
| 上下文壓縮 | `compaction.js` | 無 |
| 跨 session 記憶 | `memory.js` | 無 |
| 對話持久化 | `session.js` | 無 |
| 技能/指令/hooks/MCP | `skills.js` `commands.js` `hooks.js` `mcp.js` | 無 |
| 子 agent / workflow | `subagent.js` | 工具集改由 pack 提供（見 04）|
| 權限/白名單/危險偵測/沙箱 | `permissions.js` `allow.js` `danger.js` `sandbox.js` | 預設值參數化，機制不動 |
| TUI 串流/重試/think 過濾 | `tui.js` `retry.js` `think-filter.js` | 無 |
| 工具組裝骨架 | `agent-factory.js` | **主要改點**：工具來源 + 守衛改由 pack 注入 |
| 編排器 | `index.js` | **主要改點**：verify/git/read-before-edit 剝離成 pack |

## DomainPack 是什麼（概覽，完整規格見 02）

一個領域 = 一組注入 kernel 的東西：

```js
const codingPack = {
  name: 'coding',
  tools,              // read/write/edit/bash/grep…（編碼）
  systemPrompt,       // 編碼行為準則
  contextFiles,       // ['CLAUDE.md','AGENTS.md','XITTO.md']
  mutatingTools,      // ['write','edit','bash'] — 取代 kernel 寫死的集合
  verify,             // lint/型別自動驗收（其他領域可換或不要）
  preToolPolicy,      // read-before-edit（編碼特有守衛）
  permissionPolicy,   // 沙箱/白名單預設
};
```

## 一次 turn 的生命週期（標出 kernel ↔ pack 交界）

```
使用者輸入
  │
  ▼
[kernel] 注入 systemPrompt(pack) + contextFiles(pack) + 記憶 + skills
  │
  ▼
[kernel] agent loop：串流助理回覆
  │   ├─ 文字 → TUI(kernel)
  │   └─ 工具呼叫
  │        │
  │        ▼
  │   [kernel] beforeToolCall 守衛鏈：
  │        1. planMode 擋 mutatingTools(pack 定義哪些算 mutating)
  │        2. 上下文熔斷（kernel）
  │        3. pack.preToolPolicy（領域守衛，如 read-before-edit）  ← pack
  │        4. PreToolUse hooks（kernel）
  │        5. permissionHook（kernel；策略預設來自 pack.permissionPolicy）
  │        │
  │        ▼
  │   [kernel] 執行工具（pack.tools 之一）；沙箱包裹（kernel，若該領域啟用）
  │        │
  │        ▼
  │   [kernel] PostToolUse hooks → 回灌修正
  │
  ▼ (本輪工具跑完、助理收尾)
[kernel] pack.verify?()：領域自我驗收（編碼=lint；文件=連結檢查；無=略過）  ← pack
  │   失敗 → 回灌讓 agent 修正（kernel 機制）
  ▼
[kernel] 邊界壓縮(compaction) + 存 session + 更新 TUI 狀態列
```

交界很乾淨：**kernel 跑流程，pack 在四個插槽填領域內容**——
`systemPrompt/contextFiles`（起手）、`mutatingTools`（plan 守衛）、`preToolPolicy`（工具前守衛）、`verify`（收尾驗收），加上 `tools` 與 `permissionPolicy`。

## 為什麼這樣切是對的

- **kernel 的價值是「正確地跑一個長時間、多工具、會壓縮、會記憶、有權限的 agent」**——這部分跟領域無關，最難寫好，也最值得重用。
- **領域的價值是「會什麼工具、守什麼規矩、怎麼算做完」**——這部分每個領域不同，但都能塞進同一組插槽。
- xitto-code 已驗證 kernel 那半部能穩定運作（287 測試、真實多 provider、沙箱），抽象只是把編碼那半部拔成可換的。
