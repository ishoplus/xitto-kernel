#!/usr/bin/env python3
# 最小串流 STT WebSocket server（Vosk 協議）——供 xitto 會議室即時字幕（P2，見 docs/14）本地開發/測試用。
# 依賴：pip install vosk websockets；模型見 https://alphacephei.com/vosk/models
#
# 協議（Vosk 事實標準）：
#   client → 可先送 {"config":{"sample_rate":N}}；之後送 raw PCM（16-bit mono, little-endian）二進位幀；結束送 {"eof":1}
#   server → interim：{"partial":"..."}；一句定稿：{"text":"..."}
#
# 起法：VOSK_MODEL=~/stt/vosk-model-small-cn-0.22 PORT=2700 python3 scripts/vosk-ws-server.py
import asyncio
import json
import os
import websockets
from vosk import Model, KaldiRecognizer, SetLogLevel

SetLogLevel(-1)
MODEL = os.environ.get("VOSK_MODEL", os.path.expanduser("~/stt/vosk-model-small-cn-0.22"))
PORT = int(os.environ.get("PORT", "2700"))
HOST = os.environ.get("HOST", "127.0.0.1")

print(f"loading model: {MODEL}", flush=True)
model = Model(MODEL)


async def handle(ws):
    rate = 16000
    rec = KaldiRecognizer(model, rate)
    async for msg in ws:
        if isinstance(msg, (bytes, bytearray)):
            if rec.AcceptWaveform(bytes(msg)):
                text = json.loads(rec.Result()).get("text", "")
                await ws.send(json.dumps({"text": text}, ensure_ascii=False))
            else:
                part = json.loads(rec.PartialResult()).get("partial", "")
                await ws.send(json.dumps({"partial": part}, ensure_ascii=False))
        else:
            try:
                j = json.loads(msg)
            except Exception:
                continue
            if "config" in j:
                rate = int(j["config"].get("sample_rate", rate))
                rec = KaldiRecognizer(model, rate)
            elif j.get("eof"):
                text = json.loads(rec.FinalResult()).get("text", "")
                await ws.send(json.dumps({"text": text}, ensure_ascii=False))
                break


async def main():
    async with websockets.serve(handle, HOST, PORT, max_size=None):
        print(f"vosk-ws-server 就緒：ws://{HOST}:{PORT}", flush=True)
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
