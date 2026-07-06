# 13 · 會議室錄音轉逐字稿（STT）· Meeting Speech-to-Text

> 給**部署者**的接入說明。開啟後，會議室成員可錄音，發言即時轉文字、併入決策/待辦記錄與散會紀要。
> 全程**不需修改套件原始碼**——只設環境變數 + 起一個 STT 服務。
>
> For **deployers**: enable in-meeting voice → transcript with a local (or any OpenAI-compatible) STT server, env vars only.

## 核心觀念 / Core idea

- **STT 只做轉錄**：把音訊轉成文字。xitto 打的是 **OpenAI 相容 `/v1/audio/transcriptions`**，所以任何相容服務都能接（本地 faster-whisper / 雲端）。
- **各錄各麥 → 說話人天生正確**：每位成員的瀏覽器**只錄自己的麥克風**，用其房間成員身份打標。所以**不需要 diarization（聲紋分離）模型**，說話人歸屬 100% 準。只有「一間會議室共用一支麥」才需要 diarization（見 §6）。
- **併入既有管線**：轉出的文字走**和打字發言完全相同的路徑**——即時廣播、決策/待辦沉澱進 `會議記錄.md`、散會自動出 `會議紀要-<時間戳>.pdf`。語音只是多了一個「產生文字訊息」的來源。
- **純 opt-in**：不設 `XITTO_STT_ENDPOINT` → 完全是現況，錄音鈕不顯示，零影響。

## 0. 先決條件 / Prerequisites

- 一個 OpenAI 相容的 STT 服務（本節用本地 **faster-whisper**）。
- **HTTPS 或 localhost**：瀏覽器的 `getUserMedia`（麥克風）只在安全上下文可用。純 HTTP（非 localhost）部署錄音鈕會提示需要 TLS——請先上 HTTPS / 反向代理。
- 首次會下載 Whisper 模型（`large-v3` 約數 GB）。

## 1. 起一個本地 faster-whisper（OpenAI 相容 server）

二選一：

**A. Docker（最省事）**
```bash
# GPU
docker run -p 8000:8000 --gpus all fedirz/faster-whisper-server:latest-cuda
# 無 GPU
docker run -p 8000:8000 fedirz/faster-whisper-server:latest-cpu
```

**B. pip**
```bash
pip install faster-whisper-server
faster-whisper-server        # 預設監聽 :8000
```

驗證（直接打轉錄端點）：
```bash
curl -s http://localhost:8000/v1/audio/transcriptions \
  -F file=@sample.wav -F model=Systran/faster-whisper-large-v3 -F language=zh
# → {"text":"..."}
```

> 其他相容選項：`speaches`、`whisper.cpp` 的 server、vLLM 的 audio 端點；雲端可用任何提供 `/v1/audio/transcriptions` 的服務。

## 2. 設定 xitto（環境變數）

| 變數 | 必填 | 說明 |
|------|------|------|
| `XITTO_STT_ENDPOINT` | ✅ | STT 轉錄端點，例 `http://localhost:8000/v1/audio/transcriptions`。**設了才啟用整個功能。** |
| `XITTO_STT_MODEL` | | 模型名，預設 `Systran/faster-whisper-large-v3`（依你的 STT server 而定）。 |
| `XITTO_STT_LANGUAGE` | | 語言碼，例 `zh`（中文會議建議強制，準確度更穩）；留空＝自動偵測。 |
| `XITTO_STT_KEY` | | STT 服務的 API Key（本地通常不需要）。 |
| `XITTO_MAX_AUDIO` | | 單段音訊大小上限（bytes），預設 25MB。 |

範例：
```bash
XITTO_STT_ENDPOINT=http://localhost:8000/v1/audio/transcriptions \
XITTO_STT_MODEL=Systran/faster-whisper-large-v3 \
XITTO_STT_LANGUAGE=zh \
PORT=8787 XITTO_SERVER_TOKEN=secret node src/app/server.js
```
啟動日誌會出現 `🎙 語音轉文字：已啟用 …`。

> **也可用 UI 設定（免 env、免重啟）**：master 開 `/settings` → 最下方「🎙 語音轉文字」卡片填端點/模型/語言/Key，儲存後存進 `<baseDir>/stt.json` 並自動熱重載。優先序為 **注入式 opts > `stt.json`（UI 存的）> 環境變數**——一旦用 UI 存過即以該檔為準（端點留空＝停用）。env 適合宣告式部署，UI 適合臨場調整。

## 3. 使用者怎麼用

1. 進會議室 → 側欄出現 **🎙 開始錄音**（僅在本部署啟用 STT 時顯示）。
2. 點擊 → 同意 → 允許麥克風權限 → 開始錄音（按鈕變「⏹ 停止錄音（錄音中…）」並脈動）。
3. 你的發言每 ~7 秒轉一次文字，以**你的身份**出現在會議串（帶 🎙 標記），所有成員可見。
4. 停止錄音、離開房間或關房會自動收麥。
5. 散會（最後一人離開）自動整理紀要；也可隨時點「📋 生成會議紀要」。逐字內容已在 transcript 裡。

## 4. 運作原理 / How it works

```
瀏覽器（各錄各麥, MediaRecorder 分段 ~7s 完整檔）
  └─ POST /v1/rooms/:id/audio   （帶成員 token → 說話人＝該成員）
       └─ 服務端 transcribe() → STT /v1/audio/transcriptions → 文字
            └─ rooms.say(該成員, text, source:'voice')
                 └─ 廣播(SSE) · pending · 決策/待辦 ledger(會議記錄.md) · 散會 generateMinutes()
```
端點：`POST /v1/rooms/:id/audio`（成員鑑權；body 為音訊二進位，`Content-Type` 如 `audio/webm`）。空/靜音的轉錄會被過濾，不發言。

## 5. 調優與注意 / Tuning & notes

- **中文準確度**：用 `large-v3` + `XITTO_STT_LANGUAGE=zh`；`small/medium` 明顯較差。硬體允許再考慮 `large-v3`（GPU）或 `large-v3-turbo`（更快、略降精度）。
- **延遲 vs 完整度**：目前每段 ~7 秒（完整可解碼檔）。想更即時可縮短分段窗（改 room.html 的錄音窗），但會更常在句中切斷。真正的即時字幕見 §7。
- **切段斷詞**：段邊界可能切斷句子——會議紀要對此不敏感（整段 transcript 一起整理）。
- **隱私/合規**：錄音**顯式開啟 + 全體可見逐字內容**（透明）。音訊轉完文字即棄、不落地保存。仍建議依當地法規在會議前告知並取得同意。
- **成本**：本地 faster-whisper 免 API 費、可離線/內網（合規場景首選）。

## 6. 共用麥場景（需 diarization）

若不是「各人各麥」而是「一間會議室一支麥」，則需要**聲紋分離**才能區分說話人：

- 用帶 diarization 的 STT（`whisperX` + `pyannote`、或 FunASR 的 `CAM++`、或雲端 Deepgram/AssemblyAI/Azure/訊飛）。
- 這屬 **P3**，目前 P1 未內建；如需可再擴充：`/audio` 端點接收整段會議音，STT 回帶說話人標籤，再逐段以對應身份 `say`。

## 7. 後續 / Roadmap

- **P2 即時字幕**：串流 STT，邊說邊顯示 interim 文字（需串流式 STT 後端）。
- **P3 共用麥 + diarization**（見 §6）。
- ~~STT 設定搬進 `/settings`~~ ✅ **已完成**（見 §2）：master 可在 `/settings` 頁的「🎙 語音轉文字」卡片填端點/模型/語言/Key，存進 `<baseDir>/stt.json` 並自動熱重載，不必改 env、不必重進容器。

## 8. 排錯 / Troubleshooting

| 症狀 | 原因 / 解法 |
|------|-------------|
| 沒有錄音鈕 | 未設 `XITTO_STT_ENDPOINT`，或服務未重啟。 |
| 點錄音提示「需要 HTTPS」 | `getUserMedia` 限安全上下文 → 用 https 或 localhost。 |
| 錄了但沒出字 | STT 端點不可達 / 模型名不符 / 音訊全靜音。**先在 `/settings` 的「🎙 語音轉文字」卡片按「🧪 測試語音端點」確認可連**；仍不行看服務端日誌 `voice` 與 STT server 日誌，或用 §1 的 curl 直接驗證。 |
| 中文轉得差 | 換 `large-v3` 並設 `XITTO_STT_LANGUAGE=zh`。 |
| 502 STT 失敗 | STT server 掛了或超時（預設 30s）；確認 §1 服務正常。 |
