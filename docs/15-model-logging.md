# 15 · 模型介面日誌 + 自動重試 · LLM Call Logging & Retry

> 給**部署者**的排查工具。專治內網自建端點（qwen / deepseek / glm 等 OpenAI/Anthropic 相容端點）
> 常見的 **「對話沒有回覆就中斷」**：把每次 LLM 呼叫的請求 body、HTTP 狀態、串流時序、
> stopReason/usage、錯誤原文攤成一行 JSONL，並把失敗**分類**，讓「無聲中斷」變成可 grep 的證據。
> 同時對連線類錯誤自動重試作為緩解。**不需修改套件原始碼**——環境變數即可調整或關閉。
>
> For **deployers**: one JSONL line per LLM call (request / HTTP status / stream timing / result / error),
> with an **outcome** classification, plus auto-retry on connection errors. Env-vars only.

## 核心觀念 / Core idea

- kernel 透過 `streamFn` 呼叫模型。這裡用一層 `withLogging` 包住它，接上 pi-ai 本就暴露、
  但先前沒用的兩個鉤子：`onPayload`（送出前的完整請求 body）與 `onResponse`（模型端 HTTP 狀態/headers），
  再包住串流迭代器與 `result()`，**每次呼叫寫一行** `model-calls.jsonl`。
- **關鍵是 `outcome` 分類**——把「沒回覆就中斷」拆成可辨識的原因：

  | outcome | 意義 | 常見肇因 |
  |---|---|---|
  | `ok` | 正常有內容收尾 | — |
  | `empty` | 串流結束、無錯誤、但**回應完全沒內容** | 端點回了 200 但空串流、模型被安全策略靜默攔、prompt/參數不相容 |
  | `interrupted` | 串流**途中**連線斷 / 迭代丟例外 | 反向代理逾時、`ECONNRESET`、SSE 被中途切斷、負載過高 |
  | `http-error` | 端點回 **4xx/5xx** | 401 金鑰、404 路徑/模型名、413 過長、429 限流、500/503 上游掛 |
  | `aborted` | 使用者中止（Ctrl+C / abort） | 正常操作 |
  | `error` | 串流回 `stopReason=error` 或其他例外 | 端點回了錯誤事件 |

- **自動重試**：連線類錯（`ECONNRESET/ECONNREFUSED/ETIMEDOUT`…）、`429`、`5xx` 由 SDK 層自動重試
  （預設 1 次）。這是最穩妥的緩解——在還沒開始消費串流前重試，不會污染對話訊息。
  > 注意：串流**已經開始後才中途斷**（`interrupted`）**無法**安全自動續接（會重複/錯亂），只會如實記錄。
  > 這類請調整**反向代理/閘道的讀取逾時**（見下方排查）。

## 存到哪 / Where

預設寫到每個 pack 的資料夾下，**兩個檔**：

```
<cwd>/.xitto-kernel/<pack>/logs/model-calls.jsonl   ← 每次 LLM 呼叫（模型介面）
<cwd>/.xitto-kernel/<pack>/logs/agent-loop.jsonl    ← agent loop 過程（工具/回合/收尾）
```

兩檔以 **`turnId`** 關聯同一輪對話——`model-calls` 記「呼叫模型」，`agent-loop` 記「呼叫模型之間發生了什麼」（跑了哪些工具、被守衛擋沒、回合怎麼收尾）。合看就是一條完整時間線，正是判斷「在哪一步斷的」所需。

`model-calls.jsonl` 每行一次呼叫。`label` 區分來源：`main`（主對話）、`delegate`（可寫委派子 agent）、`subagent`（唯讀子 agent）、`extract`（事實萃取）。

一行長這樣（已遮罩金鑰）：

```json
{
  "ts":"2026-07-07T10:31:22.845Z","callId":"c1","label":"main","attempt":1,"attempts":2,
  "model":{"id":"glm5.2","api":"openai-completions","provider":"internal","baseUrl":"http://llm.corp/v1"},
  "request":{"messages":8,"tools":29,"systemChars":1120,"body":{ "...完整請求 body（full 等級）..." }},
  "http":{"status":200,"headers":{"authorization":"***","content-type":"text/event-stream"}},
  "result":{"stopReason":"stop","usage":{"input":12,"output":3,"totalTokens":15},"textChars":3,"toolCalls":0},
  "timing":{"firstTokenMs":180,"durationMs":2400},
  "stream":{"endedBy":"done","events":{"start":1,"text_delta":42,"done":1}},
  "outcome":"ok"
}
```

- **金鑰不落地**：`authorization / x-api-key / api_key / cookie / secret / password` 等欄位一律遮成 `***`。
- `timing.firstTokenMs`：首字延遲（收到第一個 delta 的耗時）。`null` = 一個字都沒吐（配合 `empty` 看）。
- `stream.endedBy`：`done`（正常）/ `error` / `abort` / `natural`（串流耗盡沒收到 done）。

`agent-loop.jsonl` 每行一個 loop 事件（`kind`）：

```json
{"ts":"...","turnId":"t1-kxl7p","kind":"tool","tool":"write","isError":false,"durationMs":8,"resultChars":12,"args":"{\"path\":\"out.txt\",…}"}
{"ts":"...","turnId":"t1-kxl7p","kind":"tool","tool":"edit","isError":true,"durationMs":1,"error":"read-before-edit 擋下…"}
{"ts":"...","turnId":"t1-kxl7p","kind":"turn_end","stopReason":"error","errorMessage":"模型端空回應"}
{"ts":"...","turnId":"t1-kxl7p","kind":"agent_end","messages":6}
```

- `kind:"tool"`：每個工具呼叫的結果。**被守衛擋掉**會以 `isError:true` + `error`（攔截理由）出現在這裡——所以「工具沒跑是因為守衛」也看得到。`durationMs` 特別大＝**某個工具卡住**（另一種「中斷」）。
- `kind:"turn_end"`：每個回合收尾。`stopReason:"error"` / `errorMessage` ＝ `handleRunFailure` 的失敗收尾（例如 loop 裡丟例外、達 `maxSteps`）在此現形。
- `args`/`error` 只在 `full` 等級記錄（`brief` 只留 tool/isError/耗時）。

## 設定 / Configuration（環境變數）

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `XITTO_LOG` | （開） | 設 `off` 完全關閉日誌 |
| `XITTO_LOG_LEVEL` | `full` | `full`＝含完整請求 body + 回應 headers；`brief`＝只記狀態/耗時/usage/outcome（不含訊息內容，隱私友善）；`off`＝關 |
| `XITTO_LOG_DIR` | `<pack>/logs` | 覆寫日誌目錄（例如集中到 `/var/log/xitto`） |
| `XITTO_LOG_STDERR` | （開） | 非 `ok` 的呼叫額外在 stderr 印一行摘要；設 `0` 關掉 |
| `XITTO_LLM_RETRIES` | `1` | 連線錯/429/5xx 自動重試次數；設 `0` 關閉重試 |
| `XITTO_LLM_TIMEOUT_MS` | （無） | 單次請求逾時（毫秒）。內網模型慢時**別設太小**以免誤判中斷；用來抓「無限掛住」 |
| `XITTO_LLM_BACKOFF_MS` | `500` | 重試退避基數（第 N 次等 `N×backoff`） |

程式化亦可（覆蓋 env）：`createKernel(pack, { logging: { level: 'brief', dir }, retry: { maxRetries: 2, timeoutMs: 120000 } })`。

## 排查「沒回覆就中斷」/ Triage

1. **先看最近幾行的 outcome**（需要 `jq`）：
   ```bash
   tail -50 .xitto-kernel/*/logs/model-calls.jsonl | jq -c '{ts,label,model:.model.id,outcome,dur:.timing.durationMs,err:(.error.message // .result.errorMessage)}'
   ```
2. **只挑失敗**：
   ```bash
   jq -c 'select(.outcome!="ok")' .xitto-kernel/*/logs/model-calls.jsonl
   ```
3. **依 outcome 對症**：
   - `empty` → 端點回 200 卻沒吐字。看 `request.body`：是不是 `max_tokens` 太小、帶了該端點不支援的參數（如 prompt caching / reasoning）、或系統提示被安全策略攔。用同一 body 直接 `curl` 該端點複現。
   - `http-error` → 直接看 `http.status`：401 金鑰、404 模型名/路徑、429 限流、413 太長、5xx 上游。
   - `interrupted` → 多半是**中間層逾時**（Nginx `proxy_read_timeout`、雲 LB idle timeout、閘道 SSE 緩衝）。把讀取逾時調大、對 SSE 關閉 proxy buffering。看 `timing.durationMs` 是否卡在某個固定秒數（＝逾時值的訊號）。
   - 反覆 `empty/interrupted` 但偶爾成功 → 提高 `XITTO_LLM_RETRIES`，並檢查該內網端點的並發/穩定性。
4. **量首字延遲 / 卡住**：`timing.firstTokenMs` 特別大或 `null` → 模型端排隊或根本沒開始生成。
5. **重建整輪時間線**（哪一步斷的）——挑出某輪的 `turnId`，把兩個檔案按時間合看：
   ```bash
   TID=t1-kxl7p
   jq -c --arg t "$TID" 'select(.turnId==$t) | {ts, src:"llm", callId, outcome, stop:.result.stopReason}' .xitto-kernel/*/logs/model-calls.jsonl > /tmp/a
   jq -c --arg t "$TID" 'select(.turnId==$t) | {ts, src:"loop", kind, tool, isError, stop:.stopReason, err:.errorMessage}' .xitto-kernel/*/logs/agent-loop.jsonl >> /tmp/a
   sort /tmp/a   # 依 ts 排出：LLM 呼叫 ↔ 工具執行 ↔ 回合收尾 的完整順序
   ```
   若 LLM 呼叫全 `ok` 但最後一筆 `agent-loop` 是 `turn_end stopReason=error`／某個 `tool` 的 `durationMs` 異常大 → **斷在 loop 層（工具/守衛/例外）而非模型**。

## 隱私 / Privacy

`full` 等級會把**完整對話請求 body**寫進日誌（排查最有效，但含對話內容）。若環境敏感，設
`XITTO_LOG_LEVEL=brief` 只留中繼資料（狀態/耗時/token/outcome，不含訊息文字），或用 `XITTO_LOG_DIR`
指到受控目錄並納入既有日誌輪替（logrotate）。金鑰在任何等級都不會寫入。
