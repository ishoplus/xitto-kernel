// Server app（PoC）— 把 kernel 包成 HTTP 服務（零依賴 node:http）。
// 證明 kernel 能脫離 CLI 跑成服務：bearer token 認證、per-session 隔離工作目錄、沙箱、結構化日誌、
// JSON 或 SSE 串流。這是「另一個 app 消費同一組 kernel 事件」—— 不動 kernel 核心。
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../kernel/index.js';
import { loadModel } from './providers.js';
import { createCodingPack } from '../packs/coding/index.js';
import { createDataQueryPack } from '../packs/data-query/index.js';
import { createNotesPack } from '../packs/notes/index.js';
import { createGeneralPack } from '../packs/general/index.js';
import { createDeepResearchPack } from '../packs/deep-research/index.js';
import { createDevopsPack } from '../packs/devops/index.js';

const PACKS = {
  coding: createCodingPack, 'data-query': createDataQueryPack, notes: createNotesPack,
  general: createGeneralPack, 'deep-research': createDeepResearchPack, devops: createDevopsPack,
};

const lastText = (history) => ([...(history || [])].reverse().find((m) => m.role === 'assistant')?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/**
 * @param {Object} o
 * @param {object} o.model
 * @param {Function} o.getApiKey
 * @param {string} [o.token]        bearer token（未設＝不驗證，僅 PoC）
 * @param {string} [o.baseDir]      每個 session 的隔離工作目錄根
 * @param {boolean} [o.sandbox]     是否沙箱（預設 true：服務端跑 agent 應隔離）
 * @returns {import('node:http').Server}
 */
export function createServerApp({ model, getApiKey, token, baseDir = '.xitto-server', sandbox = true } = {}) {
  const sessions = new Map(); // sessionId -> { pack, history }
  mkdirSync(baseDir, { recursive: true });

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const authed = (req) => !token || (req.headers.authorization === `Bearer ${token}`);
  const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, packs: Object.keys(PACKS), model: model.id });
    if (!authed(req)) return json(res, 401, { error: 'unauthorized（帶 Authorization: Bearer <token>）' });

    if (req.method === 'POST' && (url.pathname === '/v1/run' || url.pathname === '/v1/stream')) {
      const body = await readBody(req);
      const make = PACKS[body.pack || 'general'];
      if (!make) return json(res, 400, { error: `未知 pack「${body.pack}」，可用：${Object.keys(PACKS).join(', ')}` });
      const sessionId = body.sessionId || newId();
      const sess = sessions.get(sessionId) || { pack: body.pack || 'general', history: [] };
      const workdir = join(baseDir, sessionId); mkdirSync(workdir, { recursive: true });
      const kernel = createKernel(make({ cwd: workdir }), { cwd: workdir, model, getApiKey, sandbox: { enabled: sandbox }, getSandbox: () => sandbox, confirm: async () => 'yes' });

      const usage = { input: 0, output: 0 };
      const streaming = url.pathname === '/v1/stream';
      if (streaming) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const onEvent = (ev) => {
        if (ev.type === 'message_end' && ev.message?.usage) { usage.input += ev.message.usage.input || 0; usage.output += ev.message.usage.output || 0; }
        if (!streaming) return;
        if (ev.type === 'tool_execution_start') sse({ type: 'tool', name: ev.toolName, args: ev.args });
        else if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') sse({ type: 'text', delta: ev.assistantMessageEvent.delta });
      };

      const t0 = Date.now();
      try {
        const r = (body.mode === 'goal')
          ? await kernel.runGoal(body.goal || body.input || '', { history: sess.history, onEvent })
          : await kernel.runTurn(body.input || '', { history: sess.history, onEvent });
        sess.history = r.messages || r.history || []; sessions.set(sessionId, sess);
        const text = r.text ?? lastText(sess.history);
        log({ pack: sess.pack, session: sessionId, mode: body.mode || 'turn', tokens: usage.input + usage.output, rounds: r.rounds, ms: Date.now() - t0 });
        const payload = { sessionId, text, usage, rounds: r.rounds, done: r.done };
        if (streaming) { sse({ type: 'done', ...payload }); res.end(); }
        else json(res, 200, payload);
      } catch (e) {
        log({ pack: sess.pack, session: sessionId, error: e.message });
        if (streaming) { sse({ type: 'error', error: e.message }); res.end(); } else json(res, 500, { error: e.message });
      }
      return;
    }
    json(res, 404, { error: 'not found' });
  });
}

export function startServer() {
  const port = Number(process.env.PORT || 8787);
  const token = process.env.XITTO_SERVER_TOKEN || 'dev-token';
  const sandbox = process.env.XITTO_SERVER_SANDBOX !== 'off';
  const { model, getApiKey } = loadModel(process.env.XITTO_MODEL);
  const server = createServerApp({ model, getApiKey, token, sandbox });
  server.listen(port, () => {
    console.log(`xitto-kernel server · http://localhost:${port} · model ${model.id} · 沙箱 ${sandbox ? '開' : '關'}`);
    console.log(`token: ${token === 'dev-token' ? 'dev-token（請設 XITTO_SERVER_TOKEN）' : '(已設定)'}`);
  });
  return server;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) startServer();
