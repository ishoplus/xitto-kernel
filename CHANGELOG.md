# Changelog

## 0.9.10

- **新增 `xitto-kernel serve` 子命令**：全域安裝者可直接 `xitto-kernel serve` 啟動 Web 前端（🪄 許願台 + 對話頁 `/chat`），不必 clone repo。
  - 旗標：`--port`/`-p`、`--local`（瀏覽/選真實資料夾、就地改檔）、`--token`、`--no-sandbox`（預設開）、`--concurrency`、`--model`；`serve --help` 有說明。沿用 `providers.json` 載 model，未設定時引導 `xitto-kernel init`。
  - `startServer(opts)` 改為可接受參數（向後相容原本的 env-only 啟動）；web 靜態檔走模組相對路徑，全域安裝即可用。
  - README（en + zh-TW）快速開始補上 `xitto-kernel serve`（原 `npm run serve` 改標示為 repo 開發用）。
- 測試 229/229。

## 0.9.9

- **新增 `uiux`（UI/UX 設計與前端介面）pack**：可存取、響應式 UI 的設計 agent；`verify` 接真 a11y 工具並行為感知化（抓壞引用/裸佔位符、改既有檔守執行期契約），附 EvalSuite 品質基準。
- **Web 前端大改版（許願台 + 對話頁）**：
  - 設計系統重構 + 全幅 app-shell + 白天/夜晚主題；一串版面 bug 修（檔案預覽改浮層 modal、對話輸入框聚焦橢圓、記憶面板與檔案預覽重疊）。
  - **工作區頁籤化**：任務／記憶固定 + 檔案動態多頁籤（上限 6、可單獨關閉、同檔去重聚焦），三面板由 `setTab` 統一切換、結構上不再重疊。
  - **對話頁右側軌道**：泡泡視圖＝工作日誌（把工具/過程/diff 移出對話）、TUI 視圖＝工作階段 HUD（pack／回合／工具數／動過的檔案，類 git status）；TUI 轉錄**彩色化**（工具行依類別上色：讀藍/改金/執行綠/網路紫）+ GFM 表格渲染。
  - **sub-agent 活動可視化**：`spawn_agent` 的子工具呼叫嵌套顯示在父步驟下 + 即時思考串流（kernel 經 `onPartial` 轉發子 agent 事件，server `mapEvent` 新增 `sub_tool`/`sub_think`/`usage`）。
  - **對話頁接上背景任務**：可丟後台跑（`/v1/tasks`），進度顯示在 HUD、可中斷；前景串流與背景任務共用同一套事件與 `readSSE`。
  - **共用「專案切換器」**：專案下拉／選資料夾／新專案三控件整合成 popover（`mountProjectSwitcher`），許願台與對話頁共用同一元件與 `/v1/fs` 資料夾選擇。
- **`read` 支援 Office/PDF 文件萃取（`doc-extract`，零相依）**：把 Word/Excel/PPT/OpenDocument/RTF/PDF 轉純文字（Office/ODF 用內建 zlib 解 ZIP + 剝 XML；PDF 退回系統 `pdftotext`），`read` 自動偵測並直接讀得到；coding/general/deep-research pack 皆接上。
- **kernel 沙箱保護關鍵目錄**：靜態策略層禁止刪除/覆寫 `.git`／`.xitto-kernel`／`.xitto-server`／`.xitto-code`（對標 Codex 把 `.git` 設唯讀，補強 Linux 上唯一防線）；只擋破壞性操作（rm/重導/tee/dd），`git` 正常 porcelain 與讀取不受影響，且僅沙箱開啟時生效；`protectedDirs` 可設定。
- **依賴升級**：ink 5→7 + react 18→19（一起乾淨升級——ink 7 peer 需 react ≥19.2，`react-devtools-core` 為 optional 不安裝）；marked 12→15（停在 `marked-terminal` 支援範圍 `<16`，取代 dependabot 的 marked 18 peer 衝突）；GitHub Actions `checkout` 4→7、`setup-node` 4→6。
- 測試 229/229。

## 0.9.8

- **新增 `patent`（專利交底書）pack**：協助使用者完成專利交底書——從與使用者的討論、或用 `grep/glob/read` 探勘進行中專案，挖掘具新穎性/進步性的發明點（一次提數個候選題目讓使用者選，不武斷定題）；`web_search/web_fetch` 做現有技術初步檢索；不確定的技術細節用 `ask` 問使用者、不臆造。
  - 內建固定 5 段式格式（現有技術及問題 / 技術方案 / 意想不到的效果 / 技術重點 / 技術特徵的檢索式）+ 半導體與智能體領域撰寫要點；`verify` 每輪守門 5 段是否齊全，缺則回灌補齊。
  - `PATENT.md` 可作專案級格式覆蓋（附 `PATENT.template.md` 範本）；CLI + 許願台雙端註冊，含 `heuristicPack`/`ROUTE_GUIDE` 自動分流。
- **共用基礎工具加固（`shared/`）**：
  - `fs-tools`：`write`/`edit` 自動建父目錄 + 原子寫（暫存檔 + rename）+ `try/catch` 結構化錯誤 + symlink 防逃逸（canonical 解析最近存在祖先）+ 讀後變更檢測（`readFiles` 升級為 `Map<realpath,mtime>`，對齊 Claude Code staleness）；`read` 加目錄/二進位/超大檔守衛；`ls` 容忍壞 symlink、傳檔報錯；`bash` 逾時改 `SIGKILL`。
  - `code-nav`：修正 `grep` 二進位偵測——原始碼中的裸 NUL 位元組改為顯式 `'\x00'`，避免被編輯器/格式化破壞後退化成「跳過所有含空格檔案」。
  - `web-tools`：`web_fetch`/`http` 加 `content-length` 上限（25MB），防巨型回應 OOM。
- **本地工作目錄依使用者選擇生成**：
  - CLI 新增 `--cwd`/`--dir`/`-C`：相對路徑展開、不存在自動建立、指到既有檔案報錯；貫穿 `--goal`/`--tui`/互動 CLI，沙箱（`within` + Seatbelt）與資料目錄全部錨定其下。
  - 許願台 local 模式對齊 CLI：抽 `ensureWorkdir` 統一 `/v1/tasks`、`/v1/run`、`/v1/stream` 三端點——缺失目錄自動建立 + `isDirectory` 守衛。
- **跨平台啟動許願台**：`serve:local` 改為 `node scripts/serve-local.js`，Windows/macOS/Linux 通用（取代原本 Unix-only 的 `VAR=value cmd` shell 語法）；README（en + zh-TW）補 Windows PowerShell/cmd 啟動指令、`patent` pack、`--cwd`。
- 測試 202/202。

## 0.9.7

- **獨立對話式網頁 `/chat`（與許願台並存）**：同一 kernel 的另一個前端——許願台是「願望→交付物」（`mode:goal`），對話頁是「逐句協作、記得上下文」（`mode:turn` + 固定 `sessionId` 多輪 + SSE 串流）。後端零改動（`/v1/stream` 早已支援 `mode:turn`）。
  - 零依賴單檔 `src/app/web/chat.html`：對話泡泡、串流游標、工具動作 inline 收合 + 彩色 diff、對話清單／續接（前端持久化 transcript，`sessionId` 綁伺服器 history）、停止、markdown 渲染、IME 安全。
  - **共用工作區**：與許願台同一組 `localStorage`，五層沉澱跨頁累積。兩頁互加切換連結。
  - server 加 `/chat`（與 `/chat.html`）路由，沿用 token/packs/local 注入。
- **串流「停止」真正中止伺服器回合**：對話頁按停止 → abort fetch → 連線關閉 → 中止 kernel 回合，不再讓伺服器空跑（沿用背景任務 `/cancel` 的 `agent.abort()` 機制，經 `onAgent` 取得 agent）。關鍵：串流回應偵測 client 斷線要用 `res 'close'`（`req 'close'` 不會觸發）。實測中止七檔任務只建出 1 檔即停。
- **白天／夜晚主題切換**：許願台與對話頁右上角加 🌙/☀️ 鈕，主題寫入 `localStorage(xk_theme)` 兩頁共用，首訪預設跟隨系統 `prefers-color-scheme`；head 內早期套用避免載入閃爍。寫死的結構色抽成 CSS 變數，`:root[data-theme=light]` 整組覆蓋為淺色。Chrome headless 實截四張（兩頁×兩色）確認無破版。
- 測試 202/202。

## 0.9.6

- **依賴遷移到維護中的 `@earendil-works/pi-ai`（修 moderate 安全漏洞）**：舊 `@mariozechner/pi-ai` 已棄用凍結（停 0.73.1），且 0.70.6 透過 `@anthropic-ai/sdk` 帶 2 個 moderate 漏洞（GHSA-p7fg-763f-g4gf）。
  - 改用 `@earendil-works/pi-ai@^0.80.2`，import 指向其 `/compat` 相容入口——保留 `streamSimple`/`completeSimple` 同簽名，**邏輯零改**。
  - 驗證：`npm audit` 0 漏洞、無 deprecation 警告、202 測試綠、`examples/live.js`（streamSimple）與 `checkGoal`（completeSimple）live 實打通過。
  - `/compat` 為官方過渡層，未來移除時需做 `createModels()` 深層遷移（追蹤 #7）。
- **許願台：本地資料夾選擇器支援隱藏資料夾**：加「顯示隱藏資料夾」開關（`/v1/fs` 支援 `hidden=1`，`node_modules` 仍一律排除）；偏好記 localStorage，隱藏資料夾以暗色標示。
- **修：執行中追加（steer）/ 回答（needs-input）框無法輸入中文**：Enter 判斷加 `!isComposing`（IME 確認候選字不再被誤送）；組字期間暫停 1.2s 輪詢重繪，避免重建 input 洗掉未確認的拼音。
- **開源治理與門面**：
  - README 英文化為預設（`README.md`），繁中移至 `README.zh-TW.md`，兩者互相連結。
  - 新增 `SECURITY.md`（私密漏洞回報 + 威脅模型）、`CODE_OF_CONDUCT.md`（Contributor Covenant 2.1）、Issue/PR 模板、`dependabot.yml`。
  - CI 加固：`npm install`→`npm ci`、加 `permissions: contents:read` 最小權限。
  - 修正 README 過時測試數字、移除失效的 `../xitto-code` 連結。
- 測試 202/202。

## 0.9.5

- **領域自動判斷（auto-routing）**：非技術使用者不必懂「該選哪個 pack」——預設「🪄 自動判斷領域」，系統依願望文字自動挑最適合的領域，並顯示「已自動用『研究』領域」+ 可在下拉覆蓋。
  - **LLM 為主**（一次輕量 `completeSimple` 分流呼叫，maxTokens 12）+ **關鍵字 heuristic 備援**（LLM 不可用／逾時／回垃圾／拋錯都不炸）；**任何不確定一律 general**（最通用，涵蓋八成）。
  - 資源型領域（data-query 需 DB、notes 需筆記庫）只在明確訊號才選，避免誤分流到跑不起來的領域；分流有 6s 逾時，不拖慢交辦。
  - 後端：`classifyPack` / `heuristicPack`（可注入 `complete` 測試）；`POST /v1/tasks` 與 `/v1/run`、`/v1/stream` 支援 `pack:"auto"`，回應帶 `pack`+`routed`；任務 view 帶 `auto`。
  - 許願台：領域下拉預設「自動」，交辦後顯示判定結果，任務卡有領域徽章（🪄自動／🧭指定）。
  - 測試 +6（202/202）：heuristic 各領域、LLM 採用／別名／落備援／拋錯不炸／不打 LLM 的捷徑。

## 0.9.4

- **執行中可中途補充（steering）**：任務跑到一半,使用者可隨時插話調整方向/補需求,不必取消重來。
  - 排隊注入,**不中斷正在跑的工具**——下一個邊界才生效:
    - agent 串流中 → 即時排進 agent 的 steeringQueue(turn 邊界 drain)
    - 回合之間(goal loop 的驗收空檔,agent 已收尾)→ 緩衝到 task,kernel 下一輪用 `drainSteer` 折進指令
    - 兩路互斥,不重複套用
  - 後端:`createTaskStore.steer(id,text)` + `POST /v1/tasks/:id/steer`;kernel `runGoal` 新增 `opts.drainSteer` 鉤子
  - 許願台:進行中顯示補充輸入框(Enter 送出)+「✋ 已收到,會在下一步納入」回饋;輸入內容/游標在每 1.2s 輪詢重繪間保留,不洗掉打到一半的字
  - 測試 +4(196/196):串流即時路徑、回合間緩衝/drain-once、非進行中擋下、drainSteer 折進指令

## 0.9.3

- **許願台佈局優化（視覺層次 + 互動細節）**：
  - **頂部列**：專案控制（下拉 + 選資料夾 + 新專案）群組成一個卡片靠右、加底部分隔線、置中對齊;標題與控制不再擠成一團;窄螢幕隱藏副標
  - **左欄**：歷史成品與檔案兩段做成卡片區塊;**當前任務在歷史列高亮**(知道你正在看哪個);時間改友善格式(月/日 時:分);列項改輕量(hover/active),不再雙層卡片
  - **許願框**：focus 高亮邊框 + 「⌘/Ctrl+Enter 送出」提示與快捷鍵
  - **主區**：歡迎/空狀態改虛線框、置中,更像「等你下訂單」
  - 純前端(CSS/HTML/小 JS);測試 192/192 + JS 語法 + 結構驗證

## 0.9.2

- **修：報告顯示完成但找不到真實檔案**（成品寫到工作區外）。從執行歷史查出:某任務 workspace=`/Users/…/Xiza`（本地就地）,但 agent 把報告 `write` 到 `/tmp/…`、`/app/…`（絕對路徑,工作區外）→ 成品掃描只看工作區 → `artifacts:{created:[]}`,但 summary 說完成 → 使用者看到「有報告」卻找不到檔。兩道修法:
  - **告知工作目錄**：system prompt 明確寫出 cwd +「請用相對路徑寫在此目錄內,不要寫到 /tmp、/app 等外面」（agent 原本不知道工作目錄在哪,只能亂猜）
  - **寫檔限制在工作區內**：general/coding/fs-tools 的 `write`/`edit` confine 到 cwd,逃逸（絕對路徑外/`../`）直接擋下並回錯誤；讀檔不限制
  - 4 個新測試（相對 OK/絕對逃逸擋/`..` 擋/`/app` 擋）+ 真實 model 端到端（report.md 落在工作區內、artifacts 正確）。測試 192/192

## 0.9.1

- **修：任務一直迴圈無法結束**。從持久化的執行歷史分析出:某任務(查 2026 世界盃淘汰賽賽程——資訊不存在)35 步 6 輪、web_search×11 + web_fetch×23 不停繞圈,因為查不到、驗收一直判未達成、agent 每輪都有動作所以「無進展」偵測不到 → 跑到上限/被手動取消。三道防護:
  - **目標迴圈**：驗收回饋連續重複(agent 在繞圈、沒朝驗收要求收斂)→ 連 2 次相同就停(stalled),不再因「有動作」而空轉到上限
  - **agent loop 硬上限**：單回合工具呼叫達 `maxSteps`(80) → 注入「別再用工具,用現有資訊作結」逼它收尾(修 `while(true)` 無上限的潛在無限迴圈)
  - **server**：goal 任務 `maxRounds` 由 12 降到 8(許願台 fire-and-forget,不宜跑太久)
  - 1 個新測試(不可達成目標在 ≤4 輪內停止,非跑到上限)。測試 190/190

## 0.9.0

- **許願台改單頁佈局（移除分頁，許願與工作台同頁呈現）**：原本「許願 | 工作台」要切分頁。改成一頁看全部:
  - **頂部** = 許願輸入；**左欄** = 歷史成品 + 📂 檔案瀏覽器（各自獨立內捲,都到得了底）；**主區** = 當前任務/進度/成品 + 檔案預覽（共用一個 #fview）
  - 點任一檔（成品檔 或 工作區檔）都在**同一個主區預覽**；檔案瀏覽器逐層導航
  - 任務完成自動刷新左欄檔案列；切換空間/新專案/選資料夾都同步刷新歷史+檔案
  - 移除 tab 切換邏輯與多餘 DOM；交辦、看歷史、瀏覽檔案、預覽全在一頁,不再跳來跳去
  - 純前端重構；測試 189/189 + 內嵌 JS 語法檢查 + 服務頁面結構驗證（.layout/.nav/.work/#fview、無 tabs、div 平衡）

## 0.8.6

- **修：工作台預覽開啟時目錄捲不動**。`.wbleft`(檔案列) 是 `position:sticky`,清單比視窗高時 top 被釘在 14px、底部就到不了（sticky 陷阱,預覽讓整列變高時浮現）。改成側欄/檔案列/預覽**各自獨立內捲**（`max-height:calc(100vh - 28px) + overflow:auto`）,不再靠頁面捲動；窄螢幕(<=860px)回到單欄、取消內捲。測試 189/189。

## 0.8.5

- **許願台重啟後歷史還在（持久化）**：原本任務清單與對話 session 都是 in-memory,重啟全沒。改成落地:
  - **任務清單** → `.xitto-server/tasks/<id>.json`（每任務一檔,狀態變更時覆寫）,啟動載回 → **歷史成品重啟後自動顯示**
  - **對話 session** → `.xitto-server/sessions/<id>.json`,啟動載回 → **重啟後仍能「繼續/調整」**（對話脈絡跨重啟）
  - **重啟收尾**：載入時還停在 `running`/`queued`/`needs-input` 的（agent 已隨進程消失）標 `interrupted`「已中斷(重啟)」
  - 對標 Claude Code「對話自動落地」；但許願台是**自動顯示歷史**(成品清單),非明確 `--resume`(它是 chat,單位不同)
  - 1 個新測試（落地/載回/interrupted）+ 真實端到端：跑任務→重啟(新 server 同 baseDir)→歷史顯示 + 接續對話寫出「重啟前只在對話講過的偏好 42」。測試 189/189

## 0.8.4

- **桌面雙欄佈局（善用寬螢幕）**：原本單條 760px 窄欄、左右大量留白。改用 CSS grid 雙欄：
  - **許願頁** = 主區（許願輸入 + 當前任務/成品）+ **歷史側欄**（sticky，捲動主區時歷史保持可見）
  - **工作台** = 檔案瀏覽器在左、**檔案預覽在右**（並排，不必上下捲）
  - 容器加寬到 1180px；` (max-width:860px)` 自動收成單欄（窄螢幕/手機不變）
  - 純 CSS/HTML 結構調整；測試 188/188，內嵌 JS 語法檢查 + 服務頁面結構驗證通過

## 0.8.3

- **工作台改逐層瀏覽（不一次攤平整個專案）**：原本 `listWorkspaceFiles` 會遞迴把所有檔案攤成一長串,對真實專案太雜。改成像檔案總管:只列當前目錄的子資料夾+檔案,點資料夾才進去,有「上一層」。
  - 新增 `listDir(wsDir, sub)`（列單層,排除內部目錄,防穿越）；`/v1/workspaces/files` 改吃 `sub=` 逐層
  - 網頁工作台改可導航（麵包屑 + 進子資料夾 + 上一層）；切換空間/分頁時重置到根
  - 1 個新測試（listDir 不遞迴/子目錄分開/防穿越）+ 真實 server 端到端（根→src→src/utils）。測試 188/188

## 0.8.2

- **`npm run serve:local`**：一行啟動本地就地模式（= `XITTO_SERVER_LOCAL=1 XITTO_SERVER_SANDBOX=off`，token 預設 `secret`、可用 `XITTO_SERVER_TOKEN` 覆寫）。不用每次手打那串環境變數。

## 0.8.1

- **資料夾用「選」的（本地模式）**：不用打路徑。
  - 瀏覽器原生選資料夾拿不到絕對路徑(安全限制),改由 **local server 端列資料夾** → 網頁「📁 選資料夾」鈕,從家目錄點進去挑一個
  - 新增 `GET /v1/fs?path=`（**僅本地模式**;列子資料夾,排除 . 開頭/node_modules;託管模式回 403,不洩漏主機結構）
  - 網頁資料夾瀏覽器 modal（上一層/家目錄/選定）；空間下拉以 📁 標真實資料夾
  - 1 個新測試（/v1/fs 本地列檔 / 託管 403）+ 真實 server 端到端（家目錄→xiza→選 xitto*）。測試 187/187

## 0.8.0

- **本地就地模式（許願台像 Claude Code 改你選的真實資料夾）**：打通「隔離(許願台)」與「就地(Claude Code)」兩個檔案模型。
  - `XITTO_SERVER_LOCAL=1` 時,workspace 可為**真實資料夾的絕對路徑** → 任務**就地改該資料夾的檔**(無隔離副本);網頁「新專案」可貼路徑
  - 新增 `workspaceDir(baseDir, ws, local)`：local + 絕對路徑 → 就地；**否則(含託管收到絕對路徑)→ 消毒成管理空間,不逃逸**
  - 工作台端點改 query `?ws=`（容納絕對路徑）；in-place 資料夾不存在 → 400
  - 網頁注入 `__LOCAL__`；空間下拉以 `📁` 標真實資料夾
  - 4 個新測試（workspaceDir 就地/不逃逸/管理）+ 真實 server 端到端
    （local：就地改 /tmp/myproj/calc.js 的 a-b→a+b、無副本；hosted：絕對路徑被消毒不逃逸）。測試 186/186

## 0.7.1

- **成品迭代「繼續／調整」（迭代有脈絡）**：在許願台補上迭代閉環。
  - 完成的成品上加「↳ 繼續／調整這個成果」→ 送出**後續任務**,接續這次的對話（`sessionId`）+ 同工作區
    → agent 同時有「**檔案 + 當時的討論與理由**」,不只是檔案
  - 預設每個許願是乾淨新對話（不暴脹）；按「繼續」才接續那條線（像 ChatGPT 新對話 vs 接著聊）
  - 任務 view 加 `continued`（帶 sessionId = 接續）；歷史以 `↳` 標出接續鏈
  - 底層 sessionId 接續 kernel 本已支援,本版只是接到 UI + 標記
  - 1 個測試（view.continued）+ 真實 server 端到端：任務1 私下說「最不喜歡 Go」(只在對話、不在檔案)→ 後續任務「刪掉我最不喜歡的」→ 正確刪掉 Go（langs.txt 剩 Rust/Zig）。測試 185/185

## 0.7.0

- **工作台分頁（看見並管理持久工作區）**：許願台加「許願 | 📂 工作台」**同頁分頁**（不是另開頁面,共用空間/檢視器/認證）。
  - **許願**=交辦任務的主流程（不變）；**工作台**=列出當前專案累積的**所有檔案**（看/下載/刪）
  - server 新增 `GET /v1/workspaces/:ws/files`（列檔,排除 .xitto-kernel/tmp/node_modules）、`GET/DELETE /v1/workspaces/:ws/file`（取/刪,防穿越）
  - 檔案檢視器抽為通用 `renderFile(base,…)`，任務成品與工作台共用；`serveFile` 抽出（content-type/下載）
  - 讓持久工作空間從「半成品（檔案累積但看不見）」變成可見可管理；刻意保持輕量（檔案清單,非 IDE）
  - 4 個新測試（safeWs 防穿越 / listWorkspaceFiles 排除內部目錄）+ 真實 server 端到端（兩任務累積→列/取/刪/防穿越）。測試 184/184

## 0.6.4

- **許願台「展開過程」+ 彩色 diff（借 Claude Code 的工具卡/⌥展開,翻譯成非技術版）**：
  - 任務 `progress.log` 累積**完整步驟**（人話動作 + 參數摘要 + isError + 編輯的 `diff`）；`mapEvent` 的 `tool_end` 帶 `diff`
  - 網頁加「**展開過程（N 步）**」摺疊：預設安靜(只給進度+成品),展開才顯示步驟卡 + **綠 +/紅 - 彩色 diff** → 同畫面服務「只要結果」與「想看細節」兩種人
  - `_diff` 由 kernel 算好(v0.6.3),這版只是把它帶進網頁
  - 3 個新測試（tool_end 帶 diff / log 累積 + diff 補齊）+ 真實 server 端到端（建檔→改檔,改檔步驟帶 `- a-b` / `+ a+b`）。測試 182/182

## 0.6.3

- **彩色 diff（編輯一目了然）**：
  - kernel 新增 `diff.js`（LCS 行級 diff）；**在 `wrapUndo` 集中計算**——用既有的 undo 快照(before)+ 改後內容(after),
    把 `_diff` 掛在工具結果上（不進 LLM content,僅供 app 渲染）。**所有 pack 的 edit/write 免改**,二進位/超大檔自動跳過
  - TUI 渲染 `diffBlock`：`⎿ +N -N 行` + 綠 `+` / 紅 `-` 變更行（過長摺疊）
  - 4 個測試（lineDiff 增刪/新檔/超大、diffBlock 渲染、kernel edit 自動掛 _diff）+ 視覺驗證。測試 180/180
  - 註：`_diff` 已在 kernel 算好,日後接到許願台網頁很容易（目前先做 TUI）

## 0.6.2

- **TUI 補強（對標 Claude Code 的工具卡）**：
  - **工具卡**：`⏺ name(args)` 標頭 + `⎿` **多行**結果（首行對齊、續行縮排），過長摺疊成「… +N 行」（取代原本單行截斷）
  - **參數摘要人性化**：`bash(npm test)`、`edit(src/a.js)`——取最有意義的參數，不再倒整包 JSON
  - **待辦清單** ☑/◐/☐ 渲染（已有，微調配色）
  - 成功 `⎿ ✓`（綠）/ 失敗 `⎿ ✗`（紅，多顯示幾行）
  - `summarize` / `toolBlock` 抽為純函數並匯出 + 2 個測試。測試 176/176。
  - 仍缺（後續）：編輯的彩色 diff（需 edit 工具回傳前後內容）、底部模式/快捷鍵提示列強化

## 0.6.1

- **成品溯源/位置**：分邏輯與實體兩層。
  - **邏輯位置(workspace)**：成品卡永遠標出 `📁 所屬空間`,一眼知道每份成品屬於哪個專案
  - **實體路徑**：預設**不外露**(託管不洩漏伺服器絕對路徑);僅**本地模式**(`XITTO_SERVER_LOCAL=1` 或 `createServerApp({local:true})`)在 result 附 `workspaceDir`,網頁顯示「📂 檔案位置」(點擊複製,供到 Finder/Explorer 找檔)
  - 真實 live 驗證:本地模式回絕對路徑 `/…/ws/<workspace>`、託管模式 `workspaceDir` 為 undefined。測試 174/174。

## 0.6.0

成品管理 + 類型感知呈現 + 專案空間（一次補上三組優化）。

- **成品/過程檔管理**：
  - 系統提示引導 agent：成品放工作目錄根用好檔名，暫存/草稿放 `tmp/`
  - `runOutcome` 的成品掃描排除 `tmp/`（過程檔不污染交付清單）；job 完成後 server 自動清 `tmp/`
- **類型感知的成品呈現**：
  - file 端點按副檔名給對的 `content-type`（圖片能顯示、md/html 能渲染），支援 `?download=1`、二進位正確回傳
  - 網頁類型感知檢視：markdown **排版渲染**（零依賴內嵌渲染器）、圖片 `<img>`、HTML 沙箱 iframe、JSON 美化、其餘下載；每個檔有「開新分頁／下載」
  - `?token=` 查詢參數認證（img/iframe/下載這類無法帶 header 的瀏覽器 GET）
- **專案／空間（對應 Claude Code 的「目錄」,但可選＋命名＋有預設）**：
  - 網頁加「專案」下拉 + 新專案；不同空間的**檔案與五層沉澱各自獨立**；歷史按空間過濾
  - 任務 view 帶 `workspace`；POST `/v1/tasks` 接受 `workspace`（修：原本被 enqueue 丟棄）
- 3 個新測試（content-type / view.workspace / tmp 不算成品）+ 真實 server 端到端
  （markdown 成品渲染、tmp 清理、download header、query token、workspace 隔離）。測試 174/174。

## 0.5.0

- **持久工作空間（許願台成品間的關係）**：每個成品仍是獨立對話,但共用一個持久工作空間。
  - server workdir 改綁 `workspace`（`.xitto-server/ws/<workspace>`,預設 `default`）而非每 job 丟棄式 sessionId
  - 效果:① 檔案留存,後續任務能接續前面成果;② **五層沉澱跨成品累積**(偏好/技能/經驗/信任)——越用越懂你
  - history 仍每 job 獨立（不續接,避免 context 暴脹）;`workspace` 可在 POST 指定（多使用者隔離）
  - 交付檔案端點與 webhook 改用 workspace 解析；result 帶 `workspace`
- **待辦打勾**：`todo_write` 的清單進 `progress.todos`,UI 顯示 ☐/◐/☑（把「未知時長」變「可見剩餘步數」,對標 Claude Code）
- **可中斷（取消鈕）**：`POST /v1/tasks/:id/cancel` → abort 進行中 agent / 移除排隊 / 解除待答；UI「停止」鈕;狀態 `cancelled`
- 5 個新測試（取消 running/queued/已結束/待答 + todo 進度）+ 真實 server 端到端
  （Job2 接續 Job1 的檔案與記憶、todo 打勾、長任務中途取消）
- 緣由:對標 Claude Code 處理「等待焦慮」——liveness(心跳)+ transparency(進度/待辦)+ control(可中斷)

## 0.4.6

- **許願台「活著的證明」**：解決「只顯示進行中、不知道是否真的在跑」。
  - **每秒心跳時鐘**「已進行 Ns」：UI 端 1 秒 ticker（不靠 poll）,即使沒有新事件也持續跳動 → 看得到它活著
  - **思考文字可見**：progress 新增 `thinking`——累積 agent 當下串流的文字,在「思考中」階段顯示 💭 它在想什麼
    （tool/round 後清空；不存進 view 的 buffer 用 `t._textbuf`）
  - phase 新增 `thinking`；poll 由 1500ms 縮到 1200ms
  - 真實 live 驗證:時鐘 0→16s 連續跳動,階段 starting→thinking(💭)→acting(建檔→讀檔)→done
  - 1 個新測試（text 事件累積 thinking、tool/round 清空）。測試 166/166。

## 0.4.5

- **修：CLI 澄清提問被 spinner 蓋住，導致回答疑似沒被採用**。
  - `askUserQuestion` / `askConfirm` 提問前先 `stopSpin()`——否則「思考中…」spinner 每 100ms 覆蓋掉
    `❓ 問題` 與你的輸入列,使用者根本看不到 agent 在問,打的字也對不上 → 看起來像回答被忽略
  - ask_user 提問加上「agent 想問你：」更醒目
  - `ask_user` 工具結果改為自帶 `{ question, answer, note }`：把回答標為權威依據,長對話也不脫鉤
  - 驗證:kernel/server 的回答鏈本來就正確（單輪 + 多輪 live 測試:round-1 回答在 round-2 仍被採用）;
    本修針對互動 CLI 的顯示遮蔽問題

## 0.4.4

- **即時進度（許願台不再只顯示「進行中」）**：讓非技術使用者看得到 agent 在做什麼。
  - 任務 view 新增 `progress`：`{ phase, round, steps, recent[] }`——從事件流累積（排除 text 雜訊）
  - `mapEvent` 補 `round` / `verify`→`phase` 事件；goal 模式 wire `onRound` → 進度有輪數
  - 網頁把工具動作翻成人話（讀取檔案/執行指令/搜尋網路…）+ 第幾輪 + 動作數 + 動畫指示,取代靜態轉圈
  - `recent` 只留最近 6 個動作避免膨脹
  - 3 個測試（mapEvent 新事件 + progress 累積/上限）+ 真實端到端（進度快照逐步演進）

## 0.4.3

- **許願台網頁（結果導向第三刀）**：給非技術使用者的瀏覽器介面,以結果為中心、不是聊天。
  - server 服務 `GET /` → 單一 HTML（`src/app/web/index.html`,零依賴 vanilla,polling 不靠 SSE）
  - 介面:許願(送目標)→ 進行中狀態 → needs-input 時跳問題+回答框 → 收成品(摘要+產出檔案)→ 歷史清單
  - 新增 `GET /v1/tasks/:id/file?path=`：取交付檔案內容（點檔名看成品）；`resolveArtifact` 防路徑穿越
  - 任務 view 補 `goal`（顯示願望）；token 注入頁面供同源呼叫（本地自用零設定,正式部署需前置認證）
  - 2 個測試（resolveArtifact 穿越防護 + GET / 服務頁面/token 注入/API 仍需 auth）+ 真實端到端
    （許願→交付 hello.txt→點開看內容→穿越攻擊擋下）
  - 「許願→交付」三刀完成:交付抽象 + 澄清通道 + Job 介面

## 0.4.2

- **澄清通道（結果導向第二刀）**：agent 只在非問不可時暫停提問,而非盲猜或頻繁打擾。
  - 新增 `ask_user` 工具（app 提供 `config.askUser` 才注入；readOnly）；prompt 引導節制使用(能合理推斷就別問)
  - **CLI**：`askUser` 內嵌提問,使用者打字回答,agent 續跑
  - **背景任務 pause/resume**：`createTaskStore` 的 `runJob` 多收 `ask`；呼叫即轉 `needs-input` 並掛起問題;
    新增 `POST /v1/tasks/:id/answer` 回答後解除暫停、續跑（完全非同步,可隔很久才答）
  - 任務 view 帶 `pending`（待答問題）；事件流發 `needs_input` / `answered`
  - 4 個測試（工具有無/回空提示 + 佇列 pause/answer/resume + 無待答回 false）+ 真實 server 端到端
    （under-spec 目標 → agent 暫停問檔名/內容 → 答完交付正確檔案）

## 0.4.1

- **結果導向：交付物為一等公民（「對話只是過程」）**：第一刀朝非技術使用者的「許願→交付」模型。
  - 新增 `api.runOutcome(goal, opts)`：跑 goal loop,回傳**交付物** `{ done, summary, artifacts:{created,modified}, rounds, history }`
  - 交付物偵測：掃工作目錄前後 diff（pack 無關,連 bash 寫的檔也抓；排除 .xitto-kernel/node_modules/.git）
  - `--goal` 改印交付物（📦 產出/改動檔案 + 📝 摘要),不再只報達成輪數
  - server `POST /v1/tasks`（mode=goal）回 `artifacts`；背景任務 webhook payload 也帶 `artifacts`
  - 3 個測試（created/modified/無變動 + 內部沉澱檔不算交付物）+ 真實 model 端到端（產出 greet.js/example.js）
  - 後續規劃:澄清通道（ask_user 暫停/續跑）、Job 介面（成品歷史）

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
