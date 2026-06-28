# xitto-kernel

[![npm](https://img.shields.io/npm/v/xitto-kernel.svg)](https://www.npmjs.com/package/xitto-kernel)
[![CI](https://github.com/ishoplus/xitto-kernel/actions/workflows/ci.yml/badge.svg)](https://github.com/ishoplus/xitto-kernel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)

> 領域無關的 agent 底座（**可當依賴套件** — 你的領域 agent 是獨立專案，import kernel 而非 clone，升級不固化）

把 [`xitto-code`](../xitto-code) 這個完整的編碼智能體，抽象成一個**領域無關的 agent kernel** + 可插拔的 **DomainPack**。
同一個 kernel（多步工具循環、守衛鏈、權限/沙箱、provider 抽象）能承載任何領域的 agent；
「編碼」只是其中一個 DomainPack，換成「資料查詢」「知識庫」「客服/維運」等只需替換 pack。
互動 CLI 在 app 層（薄）；更豐富的 TUI 或其他前端可作為另一個 app 消費同一組 kernel 事件。

## 一句話

> **kernel 提供「怎麼跑一個 agent」，DomainPack 提供「這個 agent 會什麼、守什麼」。**

## 設計從哪來

xitto-code 經掃描後，約 **8 成已是領域無關的 kernel**；真正跟編碼綁死的只有三件事：
`read-before-edit`、`lint/型別自動驗收`、`git 整合`。本設計把這三件事從 kernel 剝離成 pack 的職責。

## 快速開始

**前置需求**：Node.js ≥ 20

**1. 安裝**（已發佈 npm）
```bash
npm install -g xitto-kernel    # 全域命令 xitto-kernel
```
> 開發本倉庫：`cd xitto-kernel && npm install && npm link`。

**2. 首次設定**（互動導引，產生 `~/.xitto-code/providers.json`）
```bash
xitto-kernel init
```
引導你選 provider（MiniMax / Anthropic / OpenAI / DeepSeek / 自訂）→ 填 model →
設定 API key（建議用環境變數參照 `${NAME}`，金鑰不落地）。已是 xitto-code 使用者可直接共用既有設定、跳過此步。
（沒設定就啟動會提示你跑 `init`；既有設定不會被覆寫，`--force` 才會合併新 provider。）

**3. 跑內建 pack（互動 CLI）**
```bash
xitto-kernel                  # coding agent（讀寫檔案、跑命令）
xitto-kernel --tui            # 完整 Ink TUI（持久狀態列、串流、Esc 中斷；需真實終端）
xitto-kernel --pack notes     # 筆記 / 知識庫 agent
xitto-kernel --pack data-query
xitto-kernel --sandbox        # 啟動就開 Seatbelt 沙箱
```

**CLI 內操作**：直接打需求（模型會自己呼叫工具）；指令 `/help` `/goal <目標>` `/sandbox` `/plan` `/undo` `/tools` `/trust` `/memory` `/sessions` `/resume` `/exit`；`Ctrl+C` 中斷該輪、閒置時再按一次離開。

**漸進式放權（trust 隨用累積）**：mutating/危險工具執行前會確認；批准時可選 `[a]` 信任整個工具、或 `[c]` 只信任「該命令簽章類」（如 `git status`、`npm test`——細粒度,`npm install` 仍會問）。選擇會**落地到 `.xitto-kernel/<pack>/allow.json`,跨 session 記得**,下次同類自動放行並標示「✓ 已信任」。`/trust` 查看、`/trust forget <項>` 撤銷、`/trust clear` 全清。一開始謹慎、用著用著越來越順手——危險命令永不寫入信任,每次都把關。

**執行中沉澱經驗（專案手冊）**：agent 摸清「這個專案怎麼做事」(建置/測試/部署指令、慣例、必經步驟、踩過的坑與修法)時,會用 `playbook_update` 按 topic 記進 `.xitto-kernel/<pack>/playbook.md`(同 topic 覆蓋,天然去重)；**下次 session 自動載入系統提示,不必重新摸索**。因檔案綁 cwd,手冊天然只對這個專案生效。`/playbook` 查看、`/playbook forget <主題>`、`/playbook clear`。分工:`memory` 存事實/偏好/決策(扁平),`playbook` 存可重複的程序知識(按主題)。

**自我結晶技能（結晶層，須驗證）**：摸出一套可重複的操作流程/SOP 時,agent 用 `skill_save` 把它**寫成新技能**(markdown)存進 `.xitto-kernel/<pack>/skills/`。**政策閘門:每個技能新增時必須附 (1) `goal` 明確目標 (2) `verify` 一條驗證指令——verify 會在沙箱實際執行,通過(exit 0)才落地**,否則拒絕並回傳輸出讓 agent 修正(危險指令一律擋下)。確保結晶的是「已驗證的成功」而非「宣稱的成功」。**本 session 立即可用 `skill` 按名載入(熱掃描),未來 session 自動列入「可用技能」**(漸進揭露:prompt 只列名稱+簡述,需要時才載全文)。**自我維護**:載入會記用量(`usedCount`);`skills_check`/`/skills check` 重跑每個技能存的 verify 偵測**漂移**——專案變動後失效的標 `⚠ stale` 浮上來讓你修或刪,保持技能庫可信(失效的在 prompt 標注、別誤用)。`/skills` 查看(含用量/失效)、`/skills forget <名>` 移除。分工:`playbook` 是專案事實性 know-how,`skill` 是可跨任務複用且**已驗證**的操作流程。這層讓 agent 像 Voyager 一樣**長出自己的技能庫**——但每條都經驗證、會自我體檢,且跑在 kernel 的沙箱 + 漸進信任治理裡。

**情節記憶 + 相關性召回（情節層）**：完成有價值的任務後,agent 用 `episode_record` 記一筆情節(摘要 + tags + 成敗)進 `.xitto-kernel/<pack>/episodes.jsonl`。**關鍵在召回不在存**:遇到相似任務時,kernel **自動**把與當前 input 最相關的 top-K 過往情節(相關性評分:關鍵詞/中文 bigram 重疊 + tag 加權 + 近期微傾)注入該輪 prompt——**只注入最相關的幾條,不全量倒**(避免稀釋 context、誤導)。也可主動 `episode_recall`。記錄時做 Jaccard 去重避免膨脹。`/episodes` 列近期、`/episodes <關鍵詞>` 測召回、`/episodes clear`。這直接解掉所有記憶系統的真正瓶頸——**召回對的那幾條**(零依賴、可解釋的評分,非黑箱 embedding)。

**事實自動萃取（事實層）**：每輪對話後,kernel 用一次輕量 LLM **自動**把「值得跨 session 記住的持久事實」(偏好、身分、長期決策、穩定設定)抽出來存進 `memory`——不再只靠 agent 自覺呼叫 `memory_save`。一次性的任務細節/閒聊會被略過(那是情節層的事),已知事實會過濾不重複。**非阻塞**(掛在 `runTurn` 回傳的 `memoryExtraction` promise,不卡回覆);`config.autoExtractMemory` 開關(CLI 預設開),`api.extractMemory()` 也可手動觸發。對標 xitto 的 extractMemory。

### 沉澱經驗：五層完整

agent 執行中自動累積經驗,且每層都有治理:

| 層 | 沉澱什麼 | 機制 |
|---|---|---|
| 反射層 | 什麼安全 | 漸進信任(per-pattern,跨 session) |
| 事實層 | 記住的事 | 每輪自動萃取持久事實進 memory |
| 程序層 | 這專案怎麼做 | playbook(按 topic,自動注入) |
| 情節層 | 做過什麼 | episodes + **相關性召回**(只注入最相關幾條) |
| 結晶層 | 可複用流程 | 自寫 skill(須驗證 + 自我體檢漂移) |

**通用自主 agent（給目標、自己做到完成）**
```bash
xitto-kernel --pack general --yes --goal "抓取 example.com 摘要成繁中寫進 summary.txt"
```
`general` pack（檔案/shell/web_fetch）+ kernel 的 **goal loop**（反覆 runTurn + LLM 自我驗收，直到達成/無進展/上限）。互動模式用 `/goal <目標>`。

**結果導向：對話只是過程，交付物才是產品**

對非技術使用者,真正要的不是「跟 AI 聊天」,是「把事做完、給我結果」。`api.runOutcome(goal)` 跑 goal loop,回傳的不是對話而是**交付物**：
```js
const o = await kernel.runOutcome('建立 greet.js 並寫個範例驗證');
// → { done, summary（做了什麼）, artifacts: { created:[...], modified:[...] }, rounds }
```
`--goal` 與 server 的 `POST /v1/tasks`（mode=goal）都會回交付物——**產出/改動的檔案**(掃工作目錄前後 diff,連 bash 寫的也抓)+ 摘要 + 是否達成。對話被降格成過程,結果(檔案/達成)被擺到最前面。背景任務的 webhook 也帶 `artifacts`。

**澄清通道（只在非問不可時才打斷你）**：自主交付的風險是「自主走錯」。`ask_user` 工具讓 agent 在**缺少關鍵資訊、無法合理推斷**時暫停提問——而非盲猜或頻繁打擾(prompt 明確引導:能用合理預設就別問)。由 app 注入 `config.askUser` 決定「問」的形態：
- **CLI**：內嵌提問,你打字回答,agent 續跑
- **背景任務**：任務轉 `needs-input` 狀態並掛起問題 → 你 `POST /v1/tasks/:id/answer` 回答 → 解除暫停、續跑(可隔數小時才答,完全非同步)

實測:給「建個設定檔但檔名/內容我還沒決定」→ agent 不亂猜,暫停問你檔名與內容 → 答完才交付正確的 `app.config.json`。這讓「許願→交付」既自主又不失控。

**🪄 許願台網頁（給非技術使用者：瀏覽器打開就用）**
```bash
XITTO_SERVER_TOKEN=secret npm run serve   # 然後瀏覽器開 http://localhost:8787/
```
不用終端機、不用碰金鑰(伺服器端管)。介面以**結果**為中心,不是聊天:
- **許願**:打一句「你想完成什麼」→ 交辦(背景跑 goal loop)
- **進行中**:**即時進度 + 活著的證明**——每秒跳動的「已進行 Ns」心跳時鐘、目前階段(思考中/執行中/驗收中)、agent 當下的**思考文字**(💭)、工具動作翻成人話、第幾輪 + 動作數。看得到它在想什麼、做什麼
- **待辦打勾**:agent 用 `todo_write` 規劃多步任務時,顯示 ☐/◐/☑ 清單,把「未知時長」變成「看得到的剩餘步數」(對標 Claude Code)
- **隨時可停**:每個進行中任務有「停止」鈕 → `POST /v1/tasks/:id/cancel`(abort 正在跑的 agent)。控制權在使用者手上,降低「啟動了控制不了的東西」的焦慮
- **需要你回答**:agent 暫停提問時,跳出問題 + 回答框(澄清通道)
- **收成品**:完成後顯示摘要 + **產出的檔案**,點檔名可直接看內容(`GET /v1/tasks/:id/file`,防路徑穿越)
- **歷史成品**:過往交辦的清單(願望 + 狀態),不是聊天串

**持久工作空間(成品間的關係)**:每個成品是**獨立的對話**(不續接前一個,避免 context 暴脹),但**共用一個持久工作空間**(`.xitto-server/ws/<workspace>`,預設 `default`)——所以 ① **檔案留存**,後面的任務能接續前面的成果(「把我上次做的 plan.md 翻成英文」);② **五層沉澱跨成品累積**(偏好/技能/經驗/信任)——它**越用越懂你**,不再是每次都從零開始的陌生人。`workspace` 可在 POST 時指定(多使用者各自一個)。

零依賴單一 HTML(`src/app/web/index.html`),polling 不靠 SSE。token 注入頁面供同源呼叫——本地自用零設定;**正式部署請前置真實認證**。

## 當成服務跑（不只 CLI）

kernel 是 UI 無關的，CLI 只是其中一個 app。`src/app/server.js` 是把它包成 **HTTP 服務**的 PoC
（零依賴 `node:http`）—— 證明「個人工具 → 可服務化底座」：

```bash
XITTO_SERVER_TOKEN=secret npm run serve     # http://localhost:8787
curl -s localhost:8787/health
curl -s -XPOST localhost:8787/v1/run -H "Authorization: Bearer secret" \
  -H content-type:application/json -d '{"pack":"general","sessionId":"s1","input":"..."}'
```

特性：bearer token 認證、**per-session 隔離工作目錄 + 歷史**（多輪記得上文）、沙箱（Seatbelt）、
結構化 JSON 日誌（審計/觀測）、6 個 pack 可選、JSON 或 SSE（`/v1/stream`）串流。
「個人 vs 生產」是 **app 層**的事 —— 同一個 kernel，CLI 與 server 是兩個 app。

**背景任務 + 完成通知（非同步交互）** —— 派任務出去、立刻拿到 `taskId`、做完回呼 webhook，不用一直盯著：
```bash
# 派任務（立刻回 202 + taskId），完成時 POST 結果到 webhook
curl -s -XPOST localhost:8787/v1/tasks -H "Authorization: Bearer secret" \
  -H content-type:application/json \
  -d '{"pack":"general","mode":"goal","goal":"...","webhook":"https://你的服務/done"}'

curl -s localhost:8787/v1/tasks            -H "Authorization: Bearer secret"   # 列表
curl -s localhost:8787/v1/tasks/<id>       -H "Authorization: Bearer secret"   # 狀態 + 結果
curl -sN localhost:8787/v1/tasks/<id>/events -H "Authorization: Bearer secret" # 附掛事件流（SSE，replay+即時）
```
限流並發 `XITTO_SERVER_CONCURRENCY`（預設 2）；webhook 完成時收到 `{taskId,status,text,usage,rounds,done}`。
這把「即時盯著看」延伸到「派任務→通知」的非同步形態（像把 agent 當同事）。

## 做你自己的領域 agent（不固化）

kernel 是**被依賴的套件**，不是被 clone 的範本。你的 agent 是獨立小專案：

```bash
xitto-kernel new-agent my-bot      # 產出獨立專案（import kernel，不改 kernel）
cd my-bot && npm install && npm start
```

產出的 `my-bot/` 只有：`pack.js`（你的領域：會什麼/守什麼）+ `index.js`（幾行啟動）+ `package.json`（`"xitto-kernel": "file:…"`）。
runtime（多步循環/串流/權限/沙箱/CLI）全在 kernel；`npm update xitto-kernel` 升級底座，**你的 agent 不會被固化**。

```
my-bot/                    ← 你的獨立專案
├── package.json           dependencies: { xitto-kernel: file:… }
├── pack.js                ← 你的 DomainPack
└── index.js               import { runCli, loadModel } from 'xitto-kernel/app'
```

> 內建的 coding / data-query / notes 是「官方範例 pack」，住在 kernel repo 裡；你的 pack 住在你自己的專案裡。兩者並存、互不固化。

## 搭建狀態

```
xitto-kernel/
├── src/
│   ├── types.js                  型別定義（DomainPack / Tool / KernelServices …）
│   ├── index.js                  公開 API（createKernel / loadPack / defineDomainPack …）
│   ├── kernel/
│   │   ├── pack-loader.js        ✅ pack 載入/驗證
│   │   ├── tool-registry.js      ✅ 工具 metadata 驅動（取代寫死名單）
│   │   ├── guard-chain.js        ✅ 固定順序 beforeToolCall 守衛鏈
│   │   ├── agent-loop.js         ✅ 移植自 xitto-code 的 Agent（串流 + 多步工具循環）
│   │   ├── provider.js           ✅ provider 呼叫適配（pi-ai streamSimple + cache 相容）
│   │   ├── security/             ✅ 真實 sandbox（守衛鏈第 5 格）
│   │   │   ├── sandbox.js        ✅ 靜態策略 + macOS Seatbelt OS 級隔離
│   │   │   ├── danger.js         ✅ 危險命令偵測（rm -rf / fork bomb / curl|sh …）
│   │   │   ├── allow.js          ✅ 命令簽章白名單
│   │   │   └── permission-step.js ✅ 第 5 格：deny→靜態策略→危險→確認（metadata 驅動）
│   │   └── index.js              ✅ createKernel：runTool ＋ runTurn ＋ sandbox 接線
│   ├── app/                      ✅ app 層（薄；TUI 不在 kernel 內）
│   │   ├── index.js              ✅ xitto-kernel/app 公開 API（runCli/loadModel/newAgent）
│   │   ├── cli.js                ✅ 互動 CLI：串流文字 + 工具顯示 + /指令 + Ctrl+C 中斷
│   │   ├── main.js               ✅ 進入點 + new-agent 子指令
│   │   ├── scaffold.js           ✅ 腳手架：產出獨立 agent 專案（不改 kernel）
│   │   ├── templates/            ✅ 獨立專案樣板（package.json/index.js/pack.js…）
│   │   └── providers.js          ✅ providers.json 載入（provider 設定屬 app，非 kernel）
│   └── packs/
│       ├── coding/               ✅ 參考 pack（read/ls/write/edit/bash/git）
│       ├── data-query/           ✅ 第二領域（證明正交）
│       ├── notes/                ✅ 第三領域（知識庫）
│       ├── general/              ✅ 通用自主 agent（檔案/shell/web/http + goal loop）
│       ├── deep-research/        ✅ 深度研究（多來源搜尋→查證→有引用結論）
│       └── devops/               ✅ 維運/SRE（shell + bash_bg + 設定 + 日誌 + 健康檢查）
├── bin/xitto-kernel.js           ✅ CLI 進入點（run / new-agent）
├── test/                         ✅ 41 測試全綠（runTurn + Seatbelt 隔離 + 腳手架 + …）
└── examples/
    ├── demo.js                   ✅ 不靠 LLM：同 kernel、兩領域、守衛真實生效
    └── live.js                   ✅ 真實 LLM（MiniMax）：模型實際呼叫工具完成任務
```

**也可跑**：`npm test`（41 綠）、`npm run demo`（不靠 LLM）、`node examples/live.js`（真實 LLM）。
**runTurn 已移植**：串流 → 工具呼叫（過 kernel 守衛鏈）→ 回灌 → 再串流的多步循環，能用真實 provider 驅動。
**真實 sandbox 已接守衛鏈第 5 格**：(A) 靜態策略擋網路/提權/危險命令；(B) macOS Seatbelt 在執行期 OS 級隔離，擋下靜態策略漏掉的混淆越界寫入。`sandboxable` 工具自動包裹，`tool.readOnly` 自動放行——全 metadata 驅動，無領域名單。
**仍為接縫（後續）**：回合內壓縮、hooks/skills/MCP/subagent、contextFiles 載入、互動權限確認（CLI 目前 headless 放行 mutating、危險命令仍擋）。更豐富的 Ink TUI 可作為另一個 app 消費同一組 kernel 事件。

## 文件索引

| 文件 | 內容 |
|------|------|
| [01-architecture.md](docs/01-architecture.md) | 分層架構、kernel 模組清單、一次 turn 的生命週期與 kernel/pack 交界 |
| [02-domain-pack-spec.md](docs/02-domain-pack-spec.md) | `DomainPack` 介面完整規格（逐欄位、必填/選填、預設）|
| [03-kernel-contract.md](docs/03-kernel-contract.md) | kernel 對 pack 提供的服務（`KernelServices`）與生命週期 hook |
| [04-migration-from-xitto-code.md](docs/04-migration-from-xitto-code.md) | 從 xitto-code 抽離的具體步驟：每個耦合點怎麼搬、風險 |
| [05-example-packs.md](docs/05-example-packs.md) | 範例 pack 對照（coding / data-query 已內建 + ops 示意）驗證同介面能跑不同領域 |
| [06-authoring-a-pack.md](docs/06-authoring-a-pack.md) | **怎麼用底座做一個新領域 agent**：最小 pack、工具形狀、三步驟、放工具 vs prompt |

## 現況與後續

**已完成**：pack 系統、工具 metadata 驅動、固定順序守衛鏈、agent loop（真實 LLM 多步循環）、
真實 sandbox（靜態策略 + macOS Seatbelt）、pack.verify 自我驗收、pack.contextFiles 載入、
**跨 session 記憶 + resume**、**互動權限確認**（/auto、--yes）、**/plan 計劃模式 + /undo**、
**git 能力**（coding pack）、**spawn_agent 子 agent**、**PreToolUse/PostToolUse hooks**、
**skills 漸進揭露**、**MCP 工具接入**、互動 CLI、腳手架（`new-agent` 產出獨立專案）。75 測試全綠。

**已發佈 npm**：`npm install -g xitto-kernel`；`new-agent` 產出的專案預設依賴 `^0.1.0`（`--local` 用 file: 開發）。
**可選後續**：Ink 全功能 TUI 可作為另一個 app（目前 CLI 已有輕量串流 markdown + 彩色 diff）。

**設計取向**：沿用 Node ESM + pi-ai provider 抽象；不重寫 xitto-code（kernel 是抽象，xitto-code 仍可獨立存在）。

## 評估（能力可量化）

每個 pack 配一個 EvalSuite（`eval/`，共用 `eval/framework.js`，不進 npm 包）。
範式：**新領域 agent = 新 pack（會什麼）+ 新 EvalSuite（怎麼打分）**。

| Suite | 對標 | 評分方式 | 跑法 | 參考結果* |
|------|------|------|------|------|
| coding | SWE-bench Verified | 隱藏測試 fail→pass（Docker）| `eval/swebench-generate.js` + 官方 harness | 3/8 resolved（真實子集）|
| coding（迷你）| SWE-bench 風格 | 隱藏測試（免 Docker）| `npm run eval` | 4/4 |
| general | GAIA 風格 | 答案比對 / 狀態檢查 | `node eval/general-run.js` | 4/4 |
| data-query | Spider/BIRD 風格 | 真實 SQLite + 答案比對 | `node eval/data-query-run.js` | 4/4 |
| deep-research | GAIA/研究 | 事實正確 + 真的查證（allOf）| `node eval/deep-research-run.js` | 3/3 |
| devops | Terminal-Bench 風格 | 狀態檢查（系統/檔案達標）| `node eval/devops-run.js` | 4/4 |
| 工具呼叫 | BFCL 風格 | 軌跡檢查（呼叫對工具/參數）| `node eval/tool-calling-run.js` | 6/6 |

\* 用 MiniMax-M2.7 跑的參考數字（小樣本）；換模型/擴樣本見 `eval/README.md`。scorer 型：`answerMatch` / `stateCheck` / `toolCalled`。

## 貢獻

見 [CONTRIBUTING.md](CONTRIBUTING.md)。核心原則：kernel 必須領域無關（安全行為靠工具 metadata，不寫死領域名單）；新領域 = 新增一個 pack，kernel 零改動。

## 授權

[MIT](LICENSE) © ishoplus
