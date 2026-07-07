# 08 · docgen：產出可交付文件（PDF / DOCX / CSV / HTML）

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
| `.docx` | HTML → Word | `pandoc`（優先）/ `soffice` | ✅ |
| `.csv` | 取 markdown 第一個 GFM 表格 → CSV | **無（零相依）**，含 UTF-8 BOM（Excel 中文）| ✅ |

**缺對應工具時**：PDF/DOCX 會自動改產**同名 `.html`** 並在 `note` 說明（與 doc-extract 的 `pdftotext` fallback 同哲學）——你永遠至少拿得到 HTML。

## 安裝渲染器（要 PDF/DOCX 時）

```bash
# PDF：任一即可
#   - 已有 Google Chrome / Chromium 就免裝
brew install wkhtmltopdf            # macOS；或裝 LibreOffice
# DOCX：
brew install pandoc                 # 最佳；或裝 LibreOffice（soffice）
# Linux：apt-get install -y pandoc libreoffice wkhtmltopdf 視需要
```

## 驗收徽章（完成定義）

docgen 接上 kernel 的 verify 契約：產出後自動驗證每份文件有效（PDF=`%PDF`、DOCX=ZIP、HTML=含標籤、CSV=非空）→ 對話頁/任務台顯示 **✓ 驗收通過 / ⚠ 未通過**，使用者一眼知道成品可交付。

## 範例

> 交辦：「整理這個資料夾的 README，做一份繁中 PDF 摘要，存成 summary.pdf」

agent 會 `read` 素材 → `gen_doc({ path: "summary.pdf", markdown: "# 摘要\n…", title: "摘要" })` → 偵測 Chrome → 產出 `summary.pdf`（中文）→ 驗收徽章 ✓。若環境沒渲染器 → 產 `summary.html` 並告知如何取得 PDF。

## 限制

- 富格式（PDF/DOCX）的版面以 HTML/CSS 為來源；複雜排版（多欄、頁首頁尾客製）有限。
- 尚未支援 PPTX（無零相依路徑，需引入 npm 庫）。
- `.csv` 只取 markdown 的**第一個**表格。
