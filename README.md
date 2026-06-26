# xitto-kernel

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

**前置需求**
- Node.js ≥ 20
- `~/.xitto-code/providers.json` —— LLM provider 設定（與 xitto-code 共用，內含 API key）。
  沒有的話，複製一份填入 key 即可（格式見 xitto-code 的 `providers.example.json`）。

**一次性設定**（讓 `xitto-kernel` 成為全域命令）
```bash
cd xitto-kernel
npm install
npm link            # 之後任何目錄都能用 xitto-kernel 命令
```
> 不想 link 也行：直接 `node /路徑/xitto-kernel/bin/xitto-kernel.js …` 或在 repo 內 `npm start`。

**跑內建 pack（互動 CLI）**
```bash
xitto-kernel                  # coding agent（讀寫檔案、跑命令）
xitto-kernel --pack notes     # 筆記 / 知識庫 agent
xitto-kernel --pack data-query
xitto-kernel --sandbox        # 啟動就開 Seatbelt 沙箱
```

**CLI 內操作**：直接打需求（模型會自己呼叫工具）；指令 `/help` `/sandbox [on|off]` `/tools` `/clear` `/exit`；`Ctrl+C` 中斷該輪、閒置時再按一次離開。

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
│       ├── coding/               ✅ 參考 pack（read/ls/write/edit/bash 真實工具）
│       ├── data-query/           ✅ 第二領域（證明正交）
│       └── notes/                ✅ 第三領域（知識庫；示範「怎麼做新領域 agent」）
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
真實 sandbox（靜態策略 + macOS Seatbelt）、互動 CLI、腳手架（`new-agent` 產出獨立專案）。41 測試全綠。

**仍為接縫（後續）**：回合內壓縮、hooks/skills/MCP/subagent、contextFiles 載入、互動權限確認
（CLI 目前 headless 放行 mutating、危險命令仍擋）、發佈到 npm（讓 `file:` 依賴變正式版本）。

**設計取向**：沿用 Node ESM + pi-ai provider 抽象；不重寫 xitto-code（kernel 是抽象，xitto-code 仍可獨立存在）。
