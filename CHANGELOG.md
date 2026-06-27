# Changelog

## 0.4.0

**「執行中沉澱經驗」五層完整**（反射 / 事實 / 程序 / 情節 / 結晶）——里程碑。

- **事實自動萃取（事實層，本版收尾）**：每輪後自動把持久事實抽進記憶,不再只靠 agent 自覺。
  - 新增 `extract.js`：`extractFacts`（輕量 LLM 單次呼叫,只抽偏好/身分/長期決策/穩定設定）
  - `runTurn` 在 `config.autoExtractMemory` 開啟時**非阻塞**萃取（掛 `result.memoryExtraction` promise,可 await）；發 `memory_extracted` 事件
  - 略過一次性任務細節/閒聊；以 existing + memory.save 去重；萃取失敗容錯不影響主流程
  - `api.extractMemory({messages})` 手動觸發；CLI 預設開啟並顯示「✓ 自動記住 N 條」
  - 4 個測試（解析 / 去重 / 容錯 / runTurn 鉤子）+ 真實 model 端到端（持久事實存、閒聊略過）
- 至此五層全齊；README 補上五層總表。

## 0.3.9

- **情節記憶 + 相關性召回（情節層）**：記「做過什麼任務」,相似任務時自動召回最相關的幾筆。
  - 新增 kernel 內建 `episodes.js`：`episode_record`（記摘要+tags+成敗,Jaccard 去重）、`episode_recall`（按相關性召回）
  - **自動召回**：`runTurn` 把與本輪 input 最相關的 top-K 過往情節注入該輪 prompt（`config.recallEpisodes=false` 可關）
  - **相關性評分引擎**（重點）：關鍵詞 + 中文 bigram 重疊 + tag 加權(×2) + 近期微傾；只回 score>0、top-K
    ——零依賴、可解釋,非黑箱 embedding；解掉記憶系統真正的瓶頸「召回對的那幾條」
  - 落地 `.xitto-kernel/<pack>/episodes.jsonl`；綁 cwd → 天然只召回該專案
  - `/episodes`（列近期）、`/episodes <關鍵詞>`（測召回）、`/episodes clear`；`api.episodes.*`
  - 6 個測試（斷詞/評分/去重/召回排序/recallSection/runTurn 自動注入）+ 真實 model 端到端
    （cors 查詢只召回 cors 情節、DB 查詢只召回 DB 情節、agent 用上召回的解法）
  - 「沉澱經驗」五層至此完成四層（反射/程序/結晶/情節）；僅餘事實層自動萃取

## 0.3.8

- **技能自我維護（用量戳記 + 漂移偵測）**：結晶後不再靜止,技能庫會自我體檢。
  - **A 用量戳記**：`skill` 載入時記 `usedCount` / `lastUsedAt`（寫進 frontmatter,不動 body）
  - **B 漂移偵測**：新增 `skills_check` 工具 + `api.skills.check()`——重跑每個技能存的 verify,
    仍 exit 0 標 `ok`、失效標 `stale`（清/設 frontmatter）；無 verify 區塊的技能回 `no-verify`(不誤判)
  - prompt 與 `/skills` 清單顯示用量與 `⚠ 已失效待修`；`/skills check` 觸發複查
  - frontmatter 簡易解析/patch（splitFront/joinFront/extractVerify）；複用 v0.3.7 存下的 verify
  - 4 個新測試（用量累加 / ok→stale→修復 / no-verify 不誤判 / api.skills.check）+ 真實 verify 端到端
    （載入計次、刪檔→stale、復原→ok）。測試 143/143。

## 0.3.7

- **技能結晶政策閘門（驗證才算數）**：每個自寫技能新增時必須有明確目標 + 通過的驗證,否則不落地。
  - `skill_save` 新增必填 `goal`（明確目標）與 `verify`（驗證指令）
  - **verify 在沙箱實際執行,exit 0 才新增**；未過則拒絕並回傳輸出供 agent 修正
  - 危險驗證指令一律擋（複用 `dangerousReason`/`sandboxViolation`）；開沙箱時 Seatbelt 包執行
  - 落地檔記 `goal`/`verified: true`/`verifiedAt` + `## 驗證（已通過）` 區塊（為日後重驗/衰減鋪路）
  - kernel 新增 `runVerify`（注入 createSkills）；確保結晶的是「已驗證的成功」而非「宣稱的成功」
  - 7 個測試 + 真實 runVerify 端到端（通過→新增 / 失敗→拒絕 / 危險→擋 / 缺 goal→拒）

## 0.3.6

- **自我結晶技能（結晶層）**：agent 摸出可重複流程時自己寫成技能,跨任務/跨 session 複用。
  - 新增 kernel 內建工具 `skill_save`（把流程結晶成 `.xitto-kernel/<pack>/skills/<name>.md`,含 frontmatter description）
  - `skill` 載入改為**熱掃描**：本 session 剛結晶的技能即時可載；未來 session 自動列入「可用技能」
  - `skill`/`skill_save` **永遠可用**（即使尚無技能,才能結晶第一個）；name slug 化防路徑穿越,同名覆蓋
  - 漸進揭露不變：prompt 只列名稱+簡述,需要時才載全文
  - `/skills`（查看）、`/skills forget <名>`；`api.skills.{list,remove,reload,path}`
  - 6 個測試 + 真實 model 端到端閉環（結晶 → 落地 → 新 session 列出並載入全文）
  - 至此「執行中沉澱經驗」反射/程序/結晶三層皆落地（事實/情節層待後續）

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
