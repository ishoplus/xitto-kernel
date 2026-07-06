// 手刻 WebSocket 原語（RFC 6455）：握手金鑰 + 幀編解碼 + 遮罩反解 + 分片。純函數，無需後端。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { acceptKey, decodeFrame, encodeFrame, encodeText, encodeClose, drainFrames, attachUpgrade, OP } from '../src/app/ws.js';

// 測試輔助：組一個「client→server」遮罩幀（RFC 要求 client 幀必遮罩）。
function maskFrame(opcode, payloadStr) {
  const data = Buffer.from(payloadStr, 'utf8');
  const mask = Buffer.from([0x1a, 0x2b, 0x3c, 0x4d]);
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, mask, masked]);
}

test('acceptKey：RFC 6455 已知向量', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('decodeFrame：解 client 遮罩幀 → 正確反遮罩（含中文 utf8）', () => {
  const f = decodeFrame(maskFrame(OP.TEXT, '方案 A 通過'));
  assert.equal(f.opcode, OP.TEXT);
  assert.equal(f.fin, true);
  assert.equal(f.payload.toString('utf8'), '方案 A 通過');
});

test('encodeFrame → decodeFrame：server 不遮罩幀 round-trip', () => {
  const f = decodeFrame(encodeText('hello 世界'));
  assert.equal(f.opcode, OP.TEXT);
  assert.equal(f.payload.toString('utf8'), 'hello 世界');
});

test('中/大長度：126（16-bit）與 127（64-bit）長度路徑', () => {
  const mid = 'x'.repeat(300);              // >125 → 走 16-bit 長度
  const fm = decodeFrame(maskFrame(OP.TEXT, mid));
  assert.equal(fm.payload.toString(), mid);
  const big = 'y'.repeat(70000);            // >65535 → 走 64-bit 長度
  const fb = decodeFrame(encodeFrame(OP.BINARY, Buffer.from(big)));
  assert.equal(fb.opcode, OP.BINARY);
  assert.equal(fb.payload.length, 70000);
});

test('decodeFrame：資料不足 → null（等更多 bytes）', () => {
  const full = maskFrame(OP.TEXT, 'incomplete-frame-payload');
  assert.equal(decodeFrame(full.subarray(0, 3)), null, '只有部分 header/payload → null');
  assert.equal(decodeFrame(Buffer.from([0x81])), null, '不足 2 bytes → null');
});

test('encodeClose：帶狀態碼的 close 幀', () => {
  const f = decodeFrame(encodeClose(1000));
  assert.equal(f.opcode, OP.CLOSE);
  assert.equal(f.payload.readUInt16BE(0), 1000);
});

test('drainFrames：一個 buffer 內多幀 → 全取出，殘餘留 rest', () => {
  const two = Buffer.concat([maskFrame(OP.TEXT, 'aaa'), maskFrame(OP.TEXT, 'bbb')]);
  const partial = maskFrame(OP.TEXT, 'ccc').subarray(0, 3);
  const { frames, rest } = drainFrames(Buffer.concat([two, partial]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].payload.toString(), 'aaa');
  assert.equal(frames[1].payload.toString(), 'bbb');
  assert.ok(rest.length > 0, '未收完的第三幀留在 rest');
});

test('attachUpgrade + makeConn：真 socket 握手 + 收發（模擬 P2：收音訊→回 interim/final）', async () => {
  const server = createServer((req, res) => res.end('http'));
  const got = [];
  attachUpgrade(server, (req, conn) => {
    conn.on('message', (data, isBinary) => {
      got.push(isBinary ? '[binary ' + data.length + ']' : data);
      conn.send(JSON.stringify({ partial: '暫定' }));  // interim
      conn.send(JSON.stringify({ text: '定稿' }));       // final
    });
    return true;
  });
  await new Promise((r) => server.listen(0, r));
  const sock = connect(server.address().port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  const key = randomBytes(16).toString('base64');
  sock.write(`GET /v1/rooms/x/audio/stream HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);

  const frames = [];
  let acc = Buffer.alloc(0), handshaken = false, resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  sock.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    if (!handshaken) {
      const i = acc.indexOf('\r\n\r\n'); if (i < 0) return;
      const head = acc.subarray(0, i).toString();
      assert.match(head, /101 Switching Protocols/);
      assert.ok(head.includes('Sec-WebSocket-Accept: ' + acceptKey(key)), '握手 Accept 正確');
      handshaken = true; acc = acc.subarray(i + 4);
    }
    for (;;) { const f = decodeFrame(acc); if (!f) break; frames.push(JSON.parse(f.payload.toString())); acc = acc.subarray(f.bytesUsed); }
    if (frames.length >= 2) resolveDone();
  });

  await new Promise((r) => setTimeout(r, 40)); // 等握手落定
  sock.write(maskFrame(OP.TEXT, 'audio-chunk'));  // client 遮罩幀
  await done;
  assert.deepEqual(got, ['audio-chunk']);
  assert.deepEqual(frames, [{ partial: '暫定' }, { text: '定稿' }], 'server 依序回 interim 再 final');
  sock.destroy(); server.close();
});
