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

**CLI 內操作**：直接打需求（模型會自己呼叫工具）；指令 `/help` `/goal <目標>` `/sandbox` `/plan` `/undo` `/tools` `/memory` `/sessions` `/resume` `/exit`；`Ctrl+C` 中斷該輪、閒置時再按一次離開。

**通用自主 agent（給目標、自己做到完成）**
```bash
xitto-kernel --pack general --yes --goal "抓取 example.com 摘要成繁中寫進 summary.txt"
```
`general` pack（檔案/shell/web_fetch）+ kernel 的 **goal loop**（反覆 runTurn + LLM 自我驗收，直到達成/無進展/上限）。互動模式用 `/goal <目標>`。

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
