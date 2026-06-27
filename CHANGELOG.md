# Changelog

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

### 變更

- `new-agent` 產出的專案預設依賴 `^<version>`（正式版本），`--local` 用 `file:` 開發
- pack.verify / pack.contextFiles slot 接通 runtime

### 修正

- test script 改 `node --test`（Node 20 不支援 `--test` glob）
- goal loop 驗收健壯性：寬鬆 JSON 解析 + 連續失敗停止

## 0.1.0

首發：kernel（pack 系統 / 工具 metadata / 守衛鏈 / agent loop / 真實 sandbox(Seatbelt)）、
互動 CLI、腳手架（`new-agent` 產出獨立專案）、三個範例 pack（coding / data-query / notes）。
