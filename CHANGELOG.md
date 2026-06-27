# Changelog

## 0.3.5

- **執行中沉澱經驗 — 專案手冊（程序層）**：agent 摸清專案「做事方法」時自己記下來,跨 session 自動載入。
  - 新增 kernel 內建工具 `playbook_update`（按 topic 記/更新,同 topic 覆蓋去重）、`playbook_remove`
  - 落地 `.xitto-kernel/<pack>/playbook.md`；綁 cwd → 天然只對該專案生效(自帶相關性範圍)
  - 開場自動注入 system prompt（`# 專案手冊`）+ 引導語；與 `memory`(事實層) 分工明確
  - `/playbook`（查看）、`/playbook forget <主題>`、`/playbook clear`；`api.playbook.{list,update,remove,clear,load,path}`
  - 5 個測試（topic 去重/多條/落地重載/多行 note/kernel 注入）+ 真實 model 端到端閉環驗證
    （agent 呼叫 playbook_update → 落地 → 新 session 自動載入）

## 0.3.4

- **漸進式放權（per-pattern 記住批准）**：把「事事都問的煩」和「全自動的怕」同時解掉。
  - 批准工具時可選 `[a]` 信任整個工具、或 `[c]` 只信任「命令簽章類」（`git status` ≠ `npm install`）
  - 信任**落地到 `.xitto-kernel/<pack>/allow.json`,跨 session 累積**；重啟後同類自動放行
  - 自動放行時標示「✓ 已信任」（`onTrusted` 回呼,維持可理解性）
  - **危險命令永不寫入信任**,即使選 always 也只放行這次
  - `/trust`（查看）、`/trust forget <項>`、`/trust clear`；`api.permissions.{list,forget,clear,path}`
  - 新增 `allow-store.js`（`memoryAllowStore` / `fileAllowStore`）；接通既有 `parseAllowFile`/`commandSignature`
  - 6 個測試 + 跨 kernel 實例（模擬重啟）整合驗證

## 0.3.3

- **背景任務 + 完成通知（非同步交互）**：server 新增「派任務→通知」形態，把 agent 當同事用。
  - `POST /v1/tasks`：立刻回 `202 + taskId`，後台跑，完成 POST 結果到 `webhook`
  - `GET /v1/tasks`、`GET /v1/tasks/:id`：列表 / 狀態 + 結果
  - `GET /v1/tasks/:id/events`：附掛事件流（SSE，replay 緩衝 + 即時）
  - 限流並發 `XITTO_SERVER_CONCURRENCY`（預設 2）
  - 抽出 `createTaskStore`（純記憶體、可測）與 `mapEvent`；`/v1/run`/`/v1/stream` 共用 `runKernel`
  - 5 個任務佇列測試（狀態轉移 / 限流 / 事件緩衝 / 完成回呼 / 訂閱）

## 0.3.2

- **沒設定就啟動 → 直接進導引**：偵測到沒有 providers.json 且在真實終端時，
  不再只印提示，而是直接帶進 `init` 設定流程，完成後接續啟動該 pack（非 TTY 仍只給提示）。

## 0.3.1

首次使用導引 —— 不再假設使用者已有 xitto-code。

### 新增

- **`xitto-kernel init`**：互動式設定導引，產生 `~/.xitto-code/providers.json`
  - 內建 provider 範本（MiniMax / Anthropic / OpenAI / DeepSeek / 自訂）
  - 引導選 provider → 填 model → 處理 API key（環境變數參照 `${NAME}` 不落地，或內嵌）
  - 既有設定不覆寫；`--force` 合併新 provider
  - pipe-safe 逐行讀取（可 `echo answers | xitto-kernel init` 腳本化）
- **沒設定就啟動**：改丟明確提示，引導跑 `xitto-kernel init`（不再叫人去找 xitto-code 的範例檔）
- README 快速開始改為 安裝 → `init` → 啟動 三步

## 0.3.0

把底座的「能力」與「體驗」補到接近 Claude Code，並擴充領域 pack 與評測。

### 新增

- **完整 Ink TUI**（`--tui`）：持久底部狀態列（model/cwd/git/權限/sandbox/plan/ctx）、`Static` 捲動轉錄、即時串流重繪、Esc 中斷、markdown/程式碼語法高亮、Select 式權限詢問；非真實終端自動退回 readline CLI
- **新領域 pack**：`deep-research`（多源檢索→深讀→綜整）、`devops`
- **agent loop 內建化**：把 xitto-code 的 agent loop 移植進 `runTurn`（自帶、用 pi-ai streamFn）
- **真實 sandbox 接入守衛鏈第 5 格**：macOS Seatbelt（sandbox-exec）OS 層隔離
- **server app PoC**：把 kernel 包成 HTTP 服務（`/v1/run`、`/v1/stream` SSE、bearer 驗證、per-session workdir）
- **評測框架**：scorers（answerMatch/stateCheck/toolCalled/allOf）+ SWE-bench mini 與真實 SWE-bench Verified adapter；各 pack eval 套件
- 套件匯出補上 `./packs/general`、`./packs/deep-research`、`./packs/devops`

### 驗證

- 真實 SWE-bench Verified：coding pack（MiniMax）可重現解出 flask-5014、requests-1142 等
- 測試 116/116 通過（含 Ink TUI 煙霧測試）

## 0.2.0

第一個功能完整版 —— 從 0.1.0（基礎 kernel + CLI + 腳手架）補齊近乎 xitto-code 等價的能力，
並加入通用自主 agent。

### 新增

- **記憶 + session resume**：`memory_save`/`memory_list` 工具自動注入；`--resume [id]`、`/sessions`、`/resume`、`/memory`
- **互動權限確認**：mutating/危險工具執行前彈確認（y/a/n）；`always` 記住；`--yes`/`/auto` 自動核准（危險仍把關）
- **計劃模式 + 撤銷**：`/plan`（只規劃、擋 mutating）、`/undo`（還原上次 write/edit）
- **git 能力**（coding pack）：`git_status` / `git_diff` / `git_log` / `git_commit`
- **子 agent**：`spawn_agent` 派唯讀子 agent 做聚焦調查
- **hooks**：PreToolUse / PostToolUse（`.xitto-kernel/<pack>/settings.json`）
- **skills**：漸進揭露（`.xitto-kernel/<pack>/skills/*.md` + `skill` 工具）
- **MCP**：連 MCP server（stdio），工具以 `mcp__<server>__<tool>` 注入
- **回合內上下文壓縮**：逼近視窗時摘要較舊對話、保留最近
- **輕量串流 markdown 渲染** + edit/write 彩色 diff（CLI）
- **通用自主 agent**：`general` pack（檔案/shell/`web_fetch`/`web_search`）+ **goal loop**
  （`runGoal` / `--goal "..."` / `/goal`：給目標、反覆做到完成、LLM 自我驗收）
- **code agent 工具升級（達 Claude Code 等級）**：
  - `grep`（正則搜內容、`path:line`、glob 過濾）、`glob`（`**` 遞迴找檔）
  - `read` 附行號 + `offset`/`limit`；`edit` 唯一性檢查 + `replaceAll`（避免改錯位置）
  - `bash` timeout 參數；`bash_bg` / `bash_output` / `bash_kill`（後台 dev server/watch）
  - `web_fetch`（coding pack 也能查線上文件）
  - **TodoWrite**（`todo_write`）：多步任務規劃/追蹤，CLI 即時清單渲染（☐/◐/☑）

### 變更

- `new-agent` 產出的專案預設依賴 `^<version>`（正式版本），`--local` 用 `file:` 開發
- pack.verify / pack.contextFiles slot 接通 runtime

### 修正

- test script 改 `node --test`（Node 20 不支援 `--test` glob）
- goal loop 驗收健壯性：寬鬆 JSON 解析 + 連續失敗停止

## 0.1.0

首發：kernel（pack 系統 / 工具 metadata / 守衛鏈 / agent loop / 真實 sandbox(Seatbelt)）、
互動 CLI、腳手架（`new-agent` 產出獨立專案）、三個範例 pack（coding / data-query / notes）。
