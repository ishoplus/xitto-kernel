// 手刻 WebSocket 原語（RFC 6455）——零依賴，供會議室即時字幕（P2，見 docs/14）等雙向即時通道使用。
// 這裡只放「純函數 codec + 握手金鑰」，可完整單測、不需任何後端；attach/proxy 屬後端相依階段另做。
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 固定魔術字串

// opcode
export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// 握手：由 client 的 Sec-WebSocket-Key 算出回應的 Sec-WebSocket-Accept。
export function acceptKey(secWebSocketKey) {
  return createHash('sha1').update(String(secWebSocketKey) + GUID).digest('base64');
}

// 解一個幀。資料不足回 null（等更多 bytes）；回 { fin, opcode, payload(已反遮罩), bytesUsed }。
// client→server 幀必帶 mask（RFC 要求）；此處都會正確反遮罩。
export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < off + 2) return null; len = buf.readUInt16BE(off); off += 2; }
  else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WS 幀過大');
    len = Number(big); off += 8;
  }
  let mask;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4; }
  if (buf.length < off + len) return null; // 幀未收完
  let payload = buf.subarray(off, off + len);
  if (masked) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  }
  return { fin, opcode, payload, bytesUsed: off + len };
}

// 編一個 server→client 幀（RFC：server 幀不遮罩）。payload 可為 string 或 Buffer。
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | (opcode & 0x0f), len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f); header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

export const encodeText = (s) => encodeFrame(OP.TEXT, Buffer.from(String(s), 'utf8'));
// close 幀：可帶 2-byte big-endian 狀態碼（預設 1000 正常關閉）。
export function encodeClose(code = 1000) {
  const b = Buffer.alloc(2); b.writeUInt16BE(code, 0);
  return encodeFrame(OP.CLOSE, b);
}

// 從一個累積 buffer 盡量取出「完整幀」，回 { frames, rest }（rest 為尚未收完的殘餘 bytes）。
export function drainFrames(buf) {
  const frames = [];
  let b = buf;
  for (;;) {
    const f = decodeFrame(b);
    if (!f) break;
    frames.push(f);
    b = b.subarray(f.bytesUsed);
  }
  return { frames, rest: b };
}

// 把已握手的 socket 包成簡單 conn：send(text) / sendBinary / close + on('message',(data,isBinary))/on('close')。
// 註：未做分片（continuation）重組——目前用途（瀏覽器每 chunk 一幀、mock 測試）皆為完整幀；日後如需再補。
export function makeConn(socket) {
  const listeners = { message: [], close: [] };
  let buf = Buffer.alloc(0), closed = false;
  const emit = (ev, ...a) => { for (const fn of listeners[ev] || []) { try { fn(...a); } catch { /* 監聽端錯不影響 */ } } };
  const doClose = () => { if (closed) return; closed = true; try { socket.end(encodeClose()); } catch { /* 略 */ } emit('close'); };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let out; try { out = drainFrames(buf); } catch { doClose(); return; } // 幀過大等 → 收線
    buf = out.rest;
    for (const f of out.frames) {
      if (f.opcode === OP.CLOSE) return doClose();
      if (f.opcode === OP.PING) { try { socket.write(encodeFrame(OP.PONG, f.payload)); } catch { /* 略 */ } continue; }
      if (f.opcode === OP.TEXT) emit('message', f.payload.toString('utf8'), false);
      else if (f.opcode === OP.BINARY) emit('message', f.payload, true);
    }
  });
  socket.on('close', () => { if (!closed) { closed = true; emit('close'); } });
  socket.on('error', () => doClose());
  return {
    send: (s) => { if (!closed) try { socket.write(encodeText(s)); } catch { /* 略 */ } },
    sendBinary: (b) => { if (!closed) try { socket.write(encodeFrame(OP.BINARY, b)); } catch { /* 略 */ } },
    close: doClose,
    on: (ev, fn) => { (listeners[ev] || (listeners[ev] = [])).push(fn); },
    get closed() { return closed; },
  };
}

// 接上 http.Server 的 'upgrade'：驗證是 WebSocket 升級、完成握手（101 + Accept），把 conn 交給 onConnect(req, conn)。
// onConnect 回 falsy / 拋錯 → 收線（例如路由不符或鑑權失敗）。
export function attachUpgrade(server, onConnect) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n',
    );
    const conn = makeConn(socket);
    // onConnect 回 false / 拋錯（路由不符、鑑權失敗）→ 直接 destroy（即時斷線），不走優雅 close 幀。
    try { if (onConnect(req, conn) === false) socket.destroy(); } catch { socket.destroy(); }
  });
}
