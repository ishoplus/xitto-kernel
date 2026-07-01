# GAIA benchmark harness

量化 kernel 對**複雜、多步驟、多工具**任務的完成度。GAIA（General AI Assistants）的每題需要推理 + 上網查證 + 讀附檔，用 **exact-match** 對標準答案評分。

kernel 用 `general` pack 跑：`web_search`（DuckDuckGo，免 key）/ `web_fetch` / `read`（可讀 Word/Excel/PDF）/ `bash` / 檔案工具。分數是「**kernel + 某個 model**」的組合能力。

## 快速 smoke test（不需下載資料）

先用內附的 6 題公開常識樣本，確認端到端接通：

```bash
node bench/gaia/run.mjs --data bench/gaia/samples.jsonl
```

會逐題印 ✅/❌，最後給各 Level 與整體正確率。想指定模型：`--model <id>`。

## 跑真實 GAIA validation set

GAIA 資料在 Hugging Face、**需登入並接受條款**（gated）：

1. 到 https://huggingface.co/datasets/gaia-benchmark/GAIA 按同意條款
2. 下載 `validation` 分割（165 題，附標準答案；`test` 分割無答案，需上傳 leaderboard）
3. 轉成本 harness 的 JSONL 格式，每行一題：
   ```json
   {"task_id":"...","Question":"...","Level":1,"Final answer":"...","file_name":"可選.xlsx"}
   ```
   （GAIA 原始 metadata.jsonl 欄位名幾乎一致，通常直接可用）
4. 附檔放 `validation.jsonl` 同層的 `files/` 目錄
5. 跑：
   ```bash
   node bench/gaia/run.mjs --data ~/gaia/validation.jsonl --level 1 --concurrency 3
   ```

## 參數

| 旗標 | 預設 | 說明 |
|---|---|---|
| `--data <path>` | `bench/gaia/samples.jsonl` | 題庫 JSONL |
| `--model <id>` | providers.json 的 defaultModel | 要測的模型 |
| `--level 1\|2\|3\|all` | `all` | 只跑某難度 |
| `--limit <n>` | 全部 | 最多跑幾題（先小量驗證） |
| `--concurrency <n>` | `3` | 並發題數 |
| `--max-rounds <n>` | `20` | 單題最多幾輪工具循環 |
| `--timeout <秒>` | `300` | 單題逾時（到點 abort） |
| `--out <path>` | `<data>.results.jsonl` | 明細輸出；**可續跑**（重跑會跳過已完成題） |

## 產出

- 逐題 `.results.jsonl`（答案、標準答案、對錯、輪數、錯誤）
- 終端印各 Level 正確率 + 整體正確率

## 注意

- **DuckDuckGo HTML 會限流**：大量並發時搜尋可能被擋，正確率會受影響。先用 `--concurrency 1~2` 與 `--limit` 小量跑。
- **多模態題**（圖片/音訊附檔）需模型本身支援；純文字模型會在這些題失分——這是「kernel+model」組合的真實反映。
- 分數低不代表 kernel 壞：GAIA 很難（GPT-4 + 外掛約 15–30%）。重點是**可重複、可比較**地看不同 model／不同 pack 的完成度趨勢。
