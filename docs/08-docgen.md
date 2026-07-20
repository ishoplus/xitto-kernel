# 08 · docgen：產出可交付文件（PDF / DOCX / PPTX / XLSX / CSV / HTML）

把產出從「草稿 `.md`」變成「可直接交付的成品」。與 `read`（讀 Office/PDF，見 doc-extract）對稱——**那個讀，這個產**。支援中文。

## 怎麼用

```bash
xitto-kernel --pack docgen --goal "做一份…的 PDF 報告，存成 report.pdf"
# 或互動：xitto-kernel --pack docgen
# 或任務台：選 docgen 領域
```

agent 用 `gen_doc` 工具產出檔案。

## `gen_doc` 工具

| 參數 | 說明 |
|---|---|
| `path` | 輸出檔路徑（相對工作目錄）。**副檔名決定格式**。 |
| `markdown` | 內容（標題 `#` / 清單 `-` / 表格 `\|` / 引言 `>` / code） |
| `title` | 可選；HTML `<title>`／文件標題 |

回傳 `{ ok, format, path, bytes, tool?, note? }`。

## 格式矩陣

| 副檔名 | 產法 | 需要的系統工具 | 中文 |
|---|---|---|---|
| `.html` | 直接產乾淨可列印 HTML | **無（零相依）** | ✅ 系統字體 |
| `.pdf` | HTML → PDF | Chrome headless / `wkhtmltopdf` / `soffice`（擇一）| ✅ |
| `.docx` | Markdown → Word（原生） | **無系統工具**（內建 npm 依賴） | ✅ |
| `.pptx` | Markdown → deck spec → PowerPoint（原生；受控商務版型、自動拆頁） | **無系統工具**（內建 npm 依賴） | ✅ |
| `.xlsx` | GFM 表格 → Excel workbook（每個表格一張工作表） | **無（零相依）** | ✅ |
| `.csv` | 取 markdown 第一個 GFM 表格 → CSV | **無（零相依）**，含 UTF-8 BOM（Excel 中文）| ✅ |

**缺 PDF 轉檔工具時**：PDF 會自動改產**同名 `.html`** 並在 `note` 說明（與 doc-extract 的 `pdftotext` fallback 同哲學）——你永遠至少拿得到 HTML。DOCX/PPTX 優先走原生產檔，失敗時才退回既有的 `pandoc`/`soffice` 轉檔路線。

無模板 `.pptx` 不讓 LLM 直接決定任意座標：`gen_doc` 會先把 markdown 轉為受控 deck spec，再套內建商務設計系統。每頁只使用固定安全版型（cover / statement / bullets / table），長 bullet 會拆短，正文每頁最多 5 條，長表格會保留表頭拆成多頁，避免像自由生成 HTML 以外的絕對定位內容那樣超版或重疊。

這裡參照 Codex 的工程方式，而不是讓模型自由發明版面：

- **Context**：LLM 只輸入 markdown 內容、語義標題與表格資料。
- **Constraints**：LLM 不手寫座標、不自創圖形語法、不要求任意絕對定位；PPT 視覺由 deterministic renderer 控制。
- **Done when**：`gen_doc` 回傳 `ok: true`，且 `quality.ok`、`verify.ok`、`verify.design.ok` 通過；若有 design issues，應拆分內容、改用已支援圖解或改走模板生成。
- **Reusable workflow**：常用圖解透過固定二級標題觸發，後續新增圖解必須同時補 renderer、文檔與回歸測試。

複雜無模板 PPTX 的建議流程是先規劃再生成：

```json
{
  "tool": "plan_pptx_deck",
  "args": {
    "title": "改善方案",
    "markdown": "# 改善方案\n## 流程圖\n- 需求\n- 設計\n- 驗證"
  }
}
```

`plan_pptx_deck` 不寫檔，只回傳 `kind: "pptx-deck-plan"`、`contract`、`summary`、逐頁 `slides` 與 `warnings`。只有 plan 沒有密度警告、圖解類型符合預期時，才呼叫 `gen_doc` 產 `.pptx`；產出後仍以 `quality` / `verify.design` 作為完成標準。

如果 `warnings` 出現 `unsupported-diagram-heading`，代表二級標題看起來要求圖解，但目前不在 `contract.supportedDiagrams` 內。此時 LLM 不應自創形狀語法或手寫座標；要嘛改用已支援圖解（例如 flow / matrix / architecture），要嘛先補對應 renderer、文檔與回歸測試後再開放生成。

即使 agent 跳過 `plan_pptx_deck` 直接呼叫 `gen_doc` 產 `.pptx`，工具也會在生成後重用同一個 deck plan，並把 `warnings` 併入 `verify.design.issues` 與 `quality`。因此含未支援圖解的 PPTX 可能仍會產出檔案，但 `quality.grade` 會是 `needs-repair`，不能視為可交付完成。

常用商務圖解可用二級標題觸發，不需要 LLM 手寫座標：

```md
# 改善方案
## 流程圖
- 需求確認
- 資料整理
- 方案設計
- 交付驗收

## 魚骨圖
- 人員
- 流程
- 工具
- 資料
- 風險
- 品質

## 比較矩陣
| 面向 | 方案 A | 方案 B |
| --- | --- | --- |
| 成本 | 中 | 低 |
| 速度 | 快 | 中 |

## 時間線
- Q1 需求確認
- Q2 MVP
- Q3 試點
- Q4 推廣

## 循環圖
- Plan
- Do
- Check
- Act

## 漏斗圖
- 訪客
- 線索
- 商機
- 成交

## 金字塔
- 願景
- 策略
- 能力
- 行動

## SWOT
| 類型 | 項目一 | 項目二 |
| --- | --- | --- |
| S | 品牌信任 | 渠道穩定 |
| W | 交付週期 | 成本偏高 |
| O | AI 滲透 | 新市場 |
| T | 價格競爭 | 法規變化 |

## KPI 看板
| 指標 | 數值 | 變化 |
| --- | --- | --- |
| 營收 | 120M | +18% |
| 續約率 | 91% | +3pt |

## 組織架構圖
- 總經理
- 產品
- 工程
- 營運
- 設計
- QA

## 甘特圖
| 任務 | 起始季 | 跨度 |
| --- | --- | --- |
| 需求 | 1 | 1 |
| 開發 | 2 | 2 |
| 上線 | 4 | 1 |

## Venn
- 用戶價值
- 商業可行
- 技術可落地

## 能力雷達
| 指標 | 分數 | 說明 |
| --- | --- | --- |
| 策略 | 88 | 清晰 |
| 交付 | 76 | 穩定 |
| 設計 | 82 | 可提升 |

## 系統架構圖
- Office Renderer
- Markdown Parser
- Layout Engine
- Quality Gate
```

目前內建圖解版型包含流程圖、時間線、循環圖、漏斗圖、金字塔、魚骨圖、SWOT、比較矩陣、KPI 看板、組織架構圖、甘特圖、Venn、能力雷達與系統架構圖；這些都會走固定安全區域與設計 token。

## 能力探測

`office_capabilities` 會回傳目前環境的讀寫能力矩陣，例如：

```json
{
  "read": { "docx": "built-in", "xlsx": "built-in", "pptx": "built-in", "pdf": "pdftotext" },
  "write": { "html": "built-in", "csv": "built-in", "xlsx": "built-in", "pdf": "chrome", "docx": "docx-native", "pptx": "pptx-native" },
  "tools": { "pdftotext": true, "pandoc": true, "soffice": false, "chrome": true, "wkhtmltopdf": false }
}
```

agent 在產 PDF 前可先查這個工具；`.docx/.pptx/.xlsx/.csv/.html` 是內建能力。

`gen_doc` 的回傳會附上 `quality`，用同一個欄位描述文件產物是否可交付：

```json
{
  "ok": true,
  "format": "xlsx",
  "path": "book.xlsx",
  "quality": {
    "ok": true,
    "grade": "pass",
    "score": 100,
    "structureOk": true,
    "designOk": true,
    "issueCount": 0,
    "repairCount": 0,
    "timingsMs": { "prepare": 0, "generate": 8, "verify": 2, "total": 10 }
  }
}
```

這個摘要讓上層 LLM 或前端不用理解每種格式的細節，也能一致判斷功能、體驗、性能與成果：`quality.ok` 代表可交付，`grade` 表示狀態，`timingsMs` 供性能觀測。

成功產出的 artifact 會在工作區 `.xitto-kernel/artifacts/` 寫入 sidecar metadata，保存 `quality`、`verify`、`repairs` 與檔案 size/mtime。檔案預覽讀取時會比對 size/mtime，只有目前檔案仍匹配時才回帶品質結果，避免同名重建後顯示過期驗證。

## PPTX 模板分析

`analyze_pptx_template` 會讀取使用者提供的 `.pptx` 模板，輸出可供後續生成流程使用的 manifest。這一步會解析：

- `ppt/presentation.xml` 與 presentation relationships
- slide masters 與 slide layouts
- 每個 layout 的 placeholder type、idx、位置與尺寸
- theme fonts 與 colors

範例輸出：

```json
{
  "kind": "pptx-template",
  "slideSize": { "cx": 9144000, "cy": 5143500, "type": "screen16x9" },
  "masters": 1,
  "layouts": [
    {
      "index": 1,
      "master": 1,
      "name": "Title and Content",
      "placeholders": [
        { "type": "title", "idx": "1", "x": 457200, "y": 274638, "cx": 8229600, "cy": 1143000 },
        { "type": "body", "idx": "2", "x": 457200, "y": 1600200, "cx": 8229600, "cy": 4525963 }
      ]
    }
  ],
  "theme": { "fonts": ["Aptos Display"], "colors": ["#1F4E79"] }
}
```

這是「套用 PPT 母版生成」的前置能力：先知道模板提供哪些 layout/placeholders，後續才能可靠選版式與填內容。

`generate_pptx_from_template` 會基於 `.pptx` 模板產生新簡報。支援：

- 保留模板 ZIP 內既有 master/layout/theme 檔案。
- 依每張 slide 的內容智能選擇 layout：只有標題優先 title-only/cover，有正文優先 title/body，有圖片優先 picture/image layout，有表格優先 table layout，有圖表優先 chart layout。
- 產生新 slide，填入 `title`、`body`、`images`、`tables` 與 `charts`。
- 將圖片寫入 `ppt/media`，並建立 slide relationship 供預覽與 Office 開啟；預設用 `contain` 放入 placeholder，保持原始比例不拉伸，必要時可指定 `fit: "cover"`。
- 將表格寫成真正 DrawingML table（`<a:tbl>`），不是截圖。
- 將圖表寫成 PPTX 原生 chart part（`ppt/charts/chartN.xml`），並建立 slide chart relationship；支援 bar、line、pie 與多系列資料。
- 生成前會先做 deterministic 設計修正：過長標題會縮短，過多正文會拆成續頁；若長正文同時含圖片、表格或圖表，會拆成正文頁與獨立資料頁；回傳 `repairs` 讓呼叫端知道修正了哪些風險。
- 對純文字頁、單表格頁與單圖表頁做容量控制：正文預設超過 5 條會自動拆成續頁，單行偏長時每頁最多 4 條；單表格超過 8 列會拆頁並保留表頭；單圖表超過 8 個分類會拆成續頁並保留系列，降低超出版面風險。
- 更新 `ppt/presentation.xml`、presentation relationships、content types。
- 回傳 `layouts` 讓呼叫端知道每份簡報實際用了哪些模板版型。
- 生成後自動附上 `verify`，檢查 slide/layout/image/chart relationships 與 shape 位置尺寸，並提供 `verify.design.score/issues` 做設計品質風險提示。
- 回傳 `quality` 摘要，彙總 `ok`、`grade`、`score`、`repairCount`、`issueCount` 與 `timingsMs`，讓前端或 LLM 能用同一個欄位判斷成果與性能。

範例：

```json
{
  "template": "template.pptx",
  "path": "out.pptx",
  "slides": [
    { "title": "封面" },
    { "title": "議程", "body": ["第一點", "第二點"] },
    { "title": "產品圖", "body": ["沿用模板圖位"], "images": [{ "path": "assets/product.png", "fit": "contain" }] },
    { "title": "營收表", "tables": [{ "name": "Revenue", "rows": [["季度", "金額"], ["Q1", "100"], ["Q2", "120"]] }] },
    { "title": "營收圖", "charts": [{ "name": "Revenue", "type": "bar", "categories": ["Q1", "Q2"], "values": [100, 120] }] },
    { "title": "趨勢圖", "charts": [{ "name": "Trend", "type": "line", "categories": ["Q1", "Q2"], "series": [{ "name": "North", "values": [100, 120] }, { "name": "South", "values": [80, 90] }] }] }
  ]
}
```

`validate_pptx_template_output` 可對既有 `.pptx` 單獨驗證，回傳：

```json
{
  "ok": true,
  "slides": 3,
  "images": 1,
  "tables": 1,
  "charts": 1,
  "repairs": [
    { "code": "title-shortened", "message": "標題過長，已縮短以降低換行與壓縮風險" },
    { "code": "visual-split", "message": "正文與表格/圖表同頁過密，已拆成獨立資料頁" }
  ],
  "quality": {
    "ok": true,
    "grade": "pass",
    "score": 92,
    "repairCount": 2,
    "issueCount": 0,
    "timingsMs": { "prepare": 0, "generate": 12, "verify": 2, "total": 14 }
  },
  "layouts": ["Title Only", "Title and Content", "Picture with Caption"],
  "design": {
    "ok": true,
    "score": 92,
    "issues": []
  },
  "issues": []
}
```

檢查內容包含：

- 每張 slide XML 是否存在。
- 每張 slide 是否有可解析的 slide layout relationship，且 layout 目標存在。
- 圖片 relationship 是否能找到 `ppt/media/*` 目標。
- 圖表 relationship 是否能找到 `ppt/charts/*` 目標。
- slide XML 的 `r:embed` 是否都有對應 relationship。
- 文字、圖片、表格與圖表 shape 是否有有效位置尺寸，並警告超出 slide 邊界的 shape。
- 設計品質風險：標題過長、正文行數過多、單行文字過長、表格列數過多、圖表分類/系列過多、同頁視覺物件過多。這些風險會進入 `design.issues`，不會讓結構性的 `ok` 直接失敗。

目前模板化生成尚未支援動畫與複雜版面自動填充；遇到這類需求應先分析模板 manifest，再告知可支援範圍。

## 安裝渲染器（要 PDF 時）

```bash
# PDF：任一即可
#   - 已有 Google Chrome / Chromium 就免裝
brew install wkhtmltopdf            # macOS；或裝 LibreOffice
# Linux：apt-get install -y pandoc libreoffice wkhtmltopdf 視需要
```

## 驗收徽章（完成定義）

docgen 接上 kernel 的 verify 契約：產出後自動驗證每份文件有效（PDF=`%PDF`、Office=ZIP 並可回讀文字、HTML=含標籤、CSV=非空）→ 對話頁/任務台顯示 **✓ 驗收通過 / ⚠ 未通過**，使用者一眼知道成品可交付。`.xlsx` 會用同一套 Office 萃取器回讀工作表內容。

## 專案級規範檔（`DOCGEN.md`）

docgen pack 的 `contextFiles` 會從工作目錄逐層往上找 `DOCGEN.md`，找到就注入 system prompt——用來把「這個專案的文件產出契約」固定下來（支援的圖解、什麼算完成、不准手寫座標等）。範本見 [`src/packs/docgen/DOCGEN.template.md`](../src/packs/docgen/DOCGEN.template.md)，複製到你的專案根目錄改用即可。

## 網頁預覽

工作台、聊天頁與房間頁的檔案預覽會優先對 Office/PDF 使用 `?as=preview` 取得結構化 JSON；失敗時才退回舊的 `?as=text` 純文字預覽。這讓使用者不用下載原檔，也能檢查主要內容結構：

- DOCX：段落與表格分塊顯示。
- XLSX：以工作表 tabs 切換表格，並標示公式與合併儲存格範圍。
- PPTX：用投影片縮圖導覽切換，主區顯示單張投影片卡片與頁碼；若檔案含 title/body placeholder，會用它保留標題與要點層級，並顯示投影片 relationships 內的小型圖片縮圖、DrawingML 表格與圖表摘要。
- PDF/ODF/RTF：目前以萃取文字預覽。

下載與開新分頁仍回原檔，不會執行或嵌入 Office 文件內容。

為避免超大簡報拖慢瀏覽器，`?as=preview` 的 JSON 預設限制為 2MB（可用 `XITTO_PREVIEW_JSON_MAX_BYTES` 調整）。超過時會保留文字與結構，移除 PPTX 圖片的 `dataUrl`，並在預覽中顯示略過提示。

若文件由 `gen_doc` 或 `generate_pptx_from_template` 產生，預覽 JSON 會合併 sidecar metadata：`artifactMeta`、`quality`、`verify`、`repairs`、`repaired`。前端會在 Office 預覽頂部顯示「可交付 / 需注意 / 未通過」、grade/score、修正數、問題數與總耗時，讓使用者打開檔案時就能看到成果品質。

## 範例

> 交辦：「整理這個資料夾的 README，做一份繁中 PDF 摘要，存成 summary.pdf」

agent 會 `read` 素材 → `gen_doc({ path: "summary.pdf", markdown: "# 摘要\n…", title: "摘要" })` → 偵測 Chrome → 產出 `summary.pdf`（中文）→ 驗收徽章 ✓。若環境沒渲染器 → 產 `summary.html` 並告知如何取得 PDF。

## 限制

- DOCX/PPTX 目前支援標題、段落、清單與表格的原生產出；無模板 PPTX 會走內建商務版型、自動拆頁與常用圖解版型（流程圖、時間線、循環圖、漏斗圖、金字塔、魚骨圖、SWOT、比較矩陣、KPI 看板、組織架構圖、甘特圖、Venn、能力雷達、系統架構圖），但複雜圖文版面、母片、動畫、頁首頁尾客製仍有限。
- PDF 仍以 HTML/CSS 為來源；複雜排版（多欄、頁首頁尾客製）有限。
- `.xlsx` 目前支援文字表格、多工作表、欄寬估算、簡單公式（`=` 開頭）、向上合併（`^`）、表頭樣式，以及從單表數值資料自動生成柱狀圖；尚未支援複雜樣式與跨欄合併。
- `.csv` 只取 markdown 的**第一個**表格。
