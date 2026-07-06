# 14 · 會議室即時字幕（P2 串流 STT）· 設計 RFC

> **狀態：設計，未實作。** P1（錄音轉逐字稿，見 [13](13-meeting-stt.md)）已上線；本文件把 P2「邊說邊顯示 interim 字幕」規格化，等選定串流後端即可照做。
>
> 先讀 §0「為何 P2 比 P1 大」——它決定了工作量與風險。

## 0. 為何 P2 比 P1 大（兩個硬約束）

1. **需要雙向即時通道**：P1 是 `MediaRecorder 分段 ~7s → POST 批次端點`（HTTP，單向、可測）。interim 字幕要「邊送音訊幀、邊收部分結果」→ **WebSocket**。但本專案**目前完全沒有 WS 基礎設施**（會議室廣播走 SSE 單向、無 `ws` 依賴、無 `upgrade` 處理）。
2. **串流 STT 沒有統一標準**：批次能做到「換任何 OpenAI 相容服務」，是因為 `/v1/audio/transcriptions` 是事實標準。**串流沒有**——WhisperLive / FunASR / sherpa-onnx / OpenAI Realtime 各有各的 WS 協議。所以 server 端必須挑一個協議、或做 per-backend adapter。

→ 結論：P2 = **新增 WS 通道 + 選定/適配一個串流後端協議 + interim/final 兩態 UI + 設定**。不是小改。

## 1. 目標與非目標

- **目標**：錄音中，發言者說話時，其他成員看到**逐步浮現的 interim 字幕**（灰、未定稿）；斷句後定稿（final）→ 走 P1 既有管線（廣播、決策/待辦、散會紀要）。
- **非目標**：不改 P1（批次仍是預設、fallback）；不做離線轉檔；共用麥 diarization 屬 P3。

## 2. 架構

```
瀏覽器（麥克風 → AudioWorklet/MediaRecorder 取 PCM/Opus 幀）
  └─ WS  /v1/rooms/:id/audio/stream   （成員 token 鑑權 → 說話人＝該成員）
       └─ 服務端 WS proxy ── 依設定的協議 ──► 串流 STT（WS）
            ◄─ interim  → SSE 廣播 { type:'caption', memberId, text, final:false }（短暫、不進紀錄）
            ◄─ final    → rooms.say(該成員, text, source:'voice')  ← 重用 P1 管線
```

- **interim** 用**既有 SSE 廣播**推給房內所有人（新事件型別 `caption`；前端渲染成該成員名下的浮動灰字，下一個 interim 覆蓋、final 定稿後清掉）。**不進 transcript / ledger**（未定稿的不落地）。
- **final** 直接呼叫 `rooms.say(..., source:'voice')`——**完全重用 P1**（廣播/決策待辦/散會紀要），零重複。
- 說話人歸屬仍靠「各錄各麥 + 成員 token」→ 不需 diarization。

## 3. WS 基礎設施決策

| 選項 | 取捨 |
|---|---|
| **手刻 WS（推薦）** | 契合本專案零/少依賴哲學。需 `crypto` 算 `Sec-WebSocket-Accept`（SHA1+base64 固定魔術字串）+ 幀解碼（含 client→server 必備的 mask 反遮罩）+ 幀編碼。約 80–120 行、邊界明確、可單測。掛在既有 `http.Server` 的 `'upgrade'` 事件。 |
| **加 `ws` 依賴** | 最省事、最穩，但破壞「純 node 內建」現況，且是會議室熱區的新 prod 依賴。 |

→ **建議手刻**，封裝成 `src/app/ws.js`（`acceptKey()` / `decodeFrame()` / `encodeFrame()` 純函數可測 + `attachUpgrade(server, routes)`）。

## 4. 後端協議：先支援一個，留 adapter 縫

先挑**一個**目標協議實作，其餘做 adapter：

- **首選 OpenAI Realtime（transcription）協議**：WS + JSON event（`input_audio_buffer.append` 送 base64 音訊、收 `...transcription.delta`/`.completed`）。理由：有規格文件、開源後端（如 `speaches`）在跟進、未來相容面最廣。
- **替代 adapter**：WhisperLive（自有 JSON 協議）、FunASR runtime（2-pass、中文最佳）、sherpa-onnx（Zipformer、CPU 友善）。各寫一個 `sttStreamAdapter` 把後端訊息正規化成 `{interim}｜{final}`。

設定（延伸 `stt.json`，見 [13 §2](13-meeting-stt.md)）：
```json
{ "streamEndpoint": "ws://localhost:8000/v1/realtime?intent=transcription",
  "streamProtocol": "openai-realtime" }
```
`/settings` 語音卡片加「串流端點 + 協議」欄位;留空＝P2 關閉、僅 P1 批次。

## 5. 測試計畫（可完整驗證，不需真後端）

跟 P1 一樣**用 mock 驗端到端**（P1 就是拿 mock STT server 測的，非真 faster-whisper）：

- `ws.js` 純函數：`acceptKey`/`decodeFrame`/`encodeFrame` 單測（含 mask、分片、控制幀）。
- **mock 串流 STT WS server**：收到音訊幀 → 先回 2 個 interim、再回 1 個 final。斷言：
  - interim → SSE 廣播 `caption{final:false}`、**不進** transcript/ledger；
  - final → 進房間訊息（`source:'voice'`、說話人＝該成員）、**併** P1 管線；
  - 未設 `streamEndpoint` → WS 端點回拒（P2 關）。

## 6. 取捨與風險

- **準確度 vs 延遲**：interim 天生較不準（上下文少），final 才可靠——UI 要明顯區分（灰=暫定、正常=定稿）。
- **無串流後端就用 P1**：P2 純加購;`streamEndpoint` 未設時完全是現況。
- **協議漂移**：OpenAI Realtime 仍在演進;adapter 縫讓換後端只改一層。
- **成本/資源**：串流後端多半要 GPU 才低延遲（Whisper 類）;sherpa-onnx/Vosk CPU 可跑但準度較低。

## 7. 開工條件

跑起**任一** §4 後端（Docker 最省事的是 WhisperLive 或 speaches），把 WS 端點填進設定 → 即可照本 RFC 實作 + mock 測試。手刻 WS（§3）與 mock 測試（§5）不需真後端就能先做、先驗。
