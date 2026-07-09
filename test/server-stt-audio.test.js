// 會議室語音轉文字（/audio）失敗時，把 STT 端點的真正原因帶回前端（不再是裸 502）。
// 對應線上症狀：企業私有 STT 端點回錯 → 使用者只看到 502，不知為何。現在錯誤內文＋狀態碼一路帶到回應。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApp } from '../src/app/server.js';

// 起一個假 STT 端點：回 400 + JSON 錯誤內文，模擬「模型名錯／端點不吃此請求」。
function fakeStt(status, bodyObj) {
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(bodyObj)); });
  });
  return srv;
}

test('房間 /audio：STT 端點回錯 → 502 帶真正原因（狀態碼＋內文），供前端顯示', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-stt-'));
  const stt = fakeStt(400, { error: 'model Systran/x not found' });
  await new Promise((r) => stt.listen(0, r));
  const sttUrl = `http://localhost:${stt.address().port}/v1/audio/transcriptions`;
  const app = createServerApp({
    model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', baseDir: join(base, '.srv'),
    stt: { endpoint: sttUrl, mode: 'transcriptions', model: 'Systran/x' }, // transcriptions 模式：不需 ffmpeg
  });
  await new Promise((r) => app.listen(0, r));
  const U = (p) => `http://localhost:${app.address().port}${p}`;
  const H = { authorization: 'Bearer t', 'content-type': 'application/json' };
  try {
    // 建房 + 加入（master token 兩步都可）→ 取 memberToken 當語音上傳憑證
    const room = await fetch(U('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({}) }).then((x) => x.json());
    assert.ok(room.roomId, '建房成功');
    const joined = await fetch(U(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: H, body: JSON.stringify({ name: '小明' }) }).then((x) => x.json());
    assert.ok(joined.memberId && joined.memberToken, '加入成功');
    // 上傳一段假音訊 → STT 端點回 400 → 我方回 502，且錯誤內文帶端點原因
    const audio = Buffer.alloc(2048, 1);
    const resp = await fetch(U(`/v1/rooms/${room.roomId}/audio?token=${encodeURIComponent(joined.memberToken)}`), {
      method: 'POST', headers: { 'content-type': 'audio/webm', authorization: 'Bearer ' + joined.memberToken }, body: audio,
    });
    assert.equal(resp.status, 502, 'STT 失敗 → 502');
    const j = await resp.json();
    assert.match(j.error, /STT 失敗/, '前綴');
    assert.match(j.error, /HTTP 400/, '帶狀態碼');
    assert.match(j.error, /model Systran\/x not found/, '帶端點回應內文（真正原因）');
  } finally {
    await new Promise((r) => app.close(r)); await new Promise((r) => stt.close(r)); rmSync(base, { recursive: true, force: true });
  }
});

test('語音存檔：轉錄成功 → source=voice 落完整存檔；/transcript 匯出含 🎙 與文字', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-stt2-'));
  const stt = fakeStt(200, { text: '大家好，我們開始吧' }); // 假 STT 轉錄成功
  await new Promise((r) => stt.listen(0, r));
  const sttUrl = `http://localhost:${stt.address().port}/v1/audio/transcriptions`;
  const app = createServerApp({
    model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', baseDir: join(base, '.srv'),
    stt: { endpoint: sttUrl, mode: 'transcriptions', model: 'x' },
  });
  await new Promise((r) => app.listen(0, r));
  const U = (p) => `http://localhost:${app.address().port}${p}`;
  const H = { authorization: 'Bearer t', 'content-type': 'application/json' };
  try {
    const room = await fetch(U('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({}) }).then((x) => x.json());
    const joined = await fetch(U(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: H, body: JSON.stringify({ name: '小明' }) }).then((x) => x.json());
    // 上傳語音 → 轉錄成功 → 以 source=voice 發言
    const up = await fetch(U(`/v1/rooms/${room.roomId}/audio?token=${encodeURIComponent(joined.memberToken)}`), {
      method: 'POST', headers: { 'content-type': 'audio/wav', authorization: 'Bearer ' + joined.memberToken }, body: Buffer.alloc(2048, 1),
    }).then((x) => x.json());
    assert.equal(up.text, '大家好，我們開始吧', '轉錄文字回傳');
    // 完整存檔 jsonl 應含 source:'voice'（重啟/超上限仍可區分語音）
    const jsonl = readFileSync(join(base, '.srv', 'rooms', room.roomId + '.transcript.jsonl'), 'utf8');
    const rec = jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.kind === 'user');
    assert.equal(rec.source, 'voice', '存檔記錄了語音來源');
    assert.equal(rec.text, '大家好，我們開始吧');
    // 匯出逐字稿：markdown 附件、含 🎙 與文字
    const exp = await fetch(U(`/v1/rooms/${room.roomId}/transcript?token=${encodeURIComponent(joined.memberToken)}`), { headers: { authorization: 'Bearer ' + joined.memberToken } });
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-disposition') || '', /attachment/, '附件下載');
    assert.match(exp.headers.get('content-type') || '', /markdown/, 'markdown');
    const md = await exp.text();
    assert.match(md, /🎙/, '匯出標記語音');
    assert.match(md, /大家好，我們開始吧/, '匯出含發言內容');
    assert.match(md, /小明/, '匯出含發言人');
  } finally {
    await new Promise((r) => app.close(r)); await new Promise((r) => stt.close(r)); rmSync(base, { recursive: true, force: true });
  }
});
