// STT 請求組裝 — 兩種 OpenAI 相容協定，抽成純函數以便單測（server.js 的 transcribe() 依此分流）：
//   - 'transcriptions'（預設，Whisper 風格）：multipart POST /v1/audio/transcriptions → 回 { text }。
//   - 'chat'（Qwen3-ASR-1.7B 等音頻理解模型）：JSON POST /v1/chat/completions，音頻走 input_audio(base64) →
//     回 choices[0].message.content。Qwen3-ASR chat 端點官方只文檔化 wav，而瀏覽器 MediaRecorder 錄的是
//     webm/opus，故有 ffmpeg 時先轉 16kHz 單聲道 wav，無則原格式透傳（讓 vLLM 端盡力解碼）。
import { spawnSync } from 'node:child_process';

// contentType → chat input_audio 的 format 欄位。
export function sttFormat(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('wav')) return 'wav';
  if (ct.includes('m4a') || ct.includes('mp4') || ct.includes('aac')) return 'mp4';
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
  if (ct.includes('ogg')) return 'ogg';
  if (ct.includes('webm')) return 'webm';
  return 'wav';
}

// 組 /v1/chat/completions 音頻理解請求。prompt（system）可選：用來偏置詞彙/語種/專名（Qwen3-ASR 的 context-priming）。
export function buildChatBody(cfg, base64, format) {
  const messages = [];
  const prompt = cfg && cfg.prompt ? String(cfg.prompt).trim() : '';
  if (prompt) messages.push({ role: 'system', content: prompt });
  messages.push({ role: 'user', content: [{ type: 'input_audio', input_audio: { data: base64, format } }] });
  return { model: (cfg && cfg.model) || 'Qwen/Qwen3-ASR-1.7B', messages, temperature: 0, stream: false };
}

// 從 chat 回應取轉錄文字（content 可能是字串，少數端點回 [{type:'text',text}] 陣列）。
export function parseChatTranscript(json) {
  const c = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('').trim();
  return '';
}

let _ffmpeg; // 快取偵測結果（避免每段音頻都探一次）
export function hasFfmpeg() {
  if (_ffmpeg === undefined) { try { _ffmpeg = spawnSync('ffmpeg', ['-version'], { timeout: 3000 }).status === 0; } catch { _ffmpeg = false; } }
  return _ffmpeg;
}

// 轉 16kHz / 單聲道 / wav。無 ffmpeg 或轉檔失敗 → 回 null（呼叫端退回原格式透傳）。
export function transcodeToWav(buffer) {
  if (!hasFfmpeg()) return null;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'],
    { input: buffer, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return null;
  return r.stdout;
}
