// STT chat 模式（Qwen3-ASR 等 /v1/chat/completions 音頻理解）請求組裝 / 回應解析單測。
// 純函數，不打網路、不需 ffmpeg。transcode / 端到端連線由部署時 /v1/stt/test 驗。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sttFormat, buildChatBody, parseChatTranscript } from '../src/app/stt.js';

test('sttFormat · contentType → input_audio format', () => {
  assert.equal(sttFormat('audio/wav'), 'wav');
  assert.equal(sttFormat('audio/webm;codecs=opus'), 'webm');
  assert.equal(sttFormat('audio/ogg;codecs=opus'), 'ogg');
  assert.equal(sttFormat('audio/mp4'), 'mp4');
  assert.equal(sttFormat('audio/mpeg'), 'mp3');
  assert.equal(sttFormat(''), 'wav'); // 未知 → 保守給 wav
});

test('buildChatBody · input_audio(base64) 結構 + 預設模型 + temperature 0', () => {
  const b = buildChatBody({}, 'QUJD', 'wav');
  assert.equal(b.model, 'Qwen/Qwen3-ASR-1.7B');
  assert.equal(b.temperature, 0);
  assert.equal(b.stream, false);
  assert.equal(b.messages.length, 1); // 無 prompt → 只有 user
  assert.equal(b.messages[0].role, 'user');
  assert.deepEqual(b.messages[0].content[0], { type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } });
});

test('buildChatBody · 有 prompt → 前置 system（context-priming）', () => {
  const b = buildChatBody({ model: 'my-asr', prompt: 'Terms: xitto' }, 'ZGF0YQ==', 'webm');
  assert.equal(b.model, 'my-asr');
  assert.equal(b.messages.length, 2);
  assert.deepEqual(b.messages[0], { role: 'system', content: 'Terms: xitto' });
  assert.equal(b.messages[1].content[0].input_audio.format, 'webm');
});

test('parseChatTranscript · 字串 / 陣列 / 缺值', () => {
  assert.equal(parseChatTranscript({ choices: [{ message: { content: '  你好世界 ' } }] }), '你好世界');
  assert.equal(parseChatTranscript({ choices: [{ message: { content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] } }] }), '甲乙');
  assert.equal(parseChatTranscript({}), '');
  assert.equal(parseChatTranscript({ choices: [] }), '');
  assert.equal(parseChatTranscript(null), '');
});
