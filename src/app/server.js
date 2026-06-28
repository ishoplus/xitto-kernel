// Server app（PoC）— 把 kernel 包成 HTTP 服務（零依賴 node:http）。
// 證明 kernel 能脫離 CLI 跑成服務：bearer token 認證、per-session 隔離工作目錄、沙箱、結構化日誌、
// JSON 或 SSE 串流，以及「背景任務 + 完成通知（webhook）」—— 派任務出去、做完回呼，不用一直盯著。
// 這是「另一個 app 消費同一組 kernel 事件」—— 不動 kernel 核心。
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, basename } from 'node:path';
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
const newId = (p = 's') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// 交付檔案的 content-type（讓圖片能顯示、md/html 能渲染、其餘可下載）。
const MIME = { md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', py: 'text/plain', sh: 'text/plain', css: 'text/css', xml: 'application/xml', yaml: 'text/plain', yml: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export function contentTypeFor(name) { const ext = (String(name).split('.').pop() || '').toLowerCase(); return MIME[ext] || 'application/octet-stream'; }

// 交付檔案路徑解析（防穿越）：rel 必須是 workdir 內的相對路徑,否則回 null。
export function resolveArtifact(workdir, rel) {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel)) return null;
  const full = join(workdir, rel);
  const r = relative(workdir, full);
  return (r.startsWith('..') || isAbsolute(r)) ? null : full;
}

let _webHtml;
const webHtml = () => (_webHtml ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'web', 'index.html'), 'utf8'));

// 把原始 kernel 事件壓成精簡的對外事件（串流端與背景任務共用，避免重複映射）
export const mapEvent = (ev) => {
  if (ev.type === 'tool_execution_start') return { type: 'tool', name: ev.toolName, args: ev.args };
  if (ev.type === 'tool_execution_end') return { type: 'tool_end', name: ev.toolName, isError: !!ev.isError };
  if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') return { type: 'text', delta: ev.assistantMessageEvent.delta };
  if (ev.type === 'round') return { type: 'round', round: ev.round, maxRounds: ev.maxRounds };
  if (ev.type === 'verify_start') return { type: 'phase', phase: 'verifying' };
  if (ev.type === 'verify_end') return { type: 'phase', phase: ev.ok ? 'verified' : 'fixing' };
  return null;
};

/**
 * 背景任務佇列（純記憶體、可測，與 HTTP 無關）。
 * 派任務 → 限流跑 → 緩衝事件供事後附掛 → 完成回呼（webhook）。
 * @param {Object} o
 * @param {(spec:object, emit:(ev:object)=>void)=>Promise<any>} o.runJob  實際執行（回傳值＝任務結果）
 * @param {number} [o.concurrency]   同時跑幾個（預設 2）
 * @param {(task:object)=>void} [o.onFinish]  每個任務 settle 後呼叫（拿來發 webhook）
 * @param {number} [o.maxEvents]     每任務保留最近幾筆事件（預設 500）
 */
export function createTaskStore({ runJob, concurrency = 2, onFinish, maxEvents = 500 } = {}) {
  const tasks = new Map();   // id -> task
  const queue = [];          // 等待中的 task
  const subs = new Map();    // id -> Set<(ev)=>void>
  let active = 0;

  const view = (t) => ({ taskId: t.id, status: t.status, pack: t.spec.pack || 'general', mode: t.spec.mode || 'turn', workspace: t.spec.workspace || 'default', goal: t.spec.goal || t.spec.input || '', sessionId: t.result?.sessionId || t.spec.sessionId || null, createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error, pending: t.pending || null, progress: t.progress || null });

  const emit = (t, ev) => {
    t.events.push(ev);
    if (t.events.length > maxEvents) t.events.shift();
    // 進度追蹤（給 UI 顯示「正在做什麼」,不要只顯示進行中；排除 text 雜訊）
    const p = (t.progress ||= { steps: 0, round: 0, maxRounds: 0, recent: [], phase: 'starting', thinking: '', todos: [] });
    if (ev.type === 'tool' && ev.name === 'todo_write') { if (Array.isArray(ev.args?.todos)) p.todos = ev.args.todos; } // 待辦清單（給 UI 打勾）
    else if (ev.type === 'tool') { p.steps++; p.phase = 'acting'; p.thinking = ''; t._textbuf = ''; p.recent.push({ name: ev.name, args: ev.args }); if (p.recent.length > 6) p.recent.shift(); }
    else if (ev.type === 'text') { p.phase = 'thinking'; t._textbuf = ((t._textbuf || '') + (ev.delta || '')).slice(-400); p.thinking = t._textbuf.replace(/\s+/g, ' ').trim().slice(-150); }
    else if (ev.type === 'round') { p.round = ev.round; if (ev.maxRounds) p.maxRounds = ev.maxRounds; p.thinking = ''; t._textbuf = ''; }
    else if (ev.type === 'phase') p.phase = ev.phase;
    else if (ev.type === 'needs_input') p.phase = 'needs-input';
    else if (ev.type === 'answered') p.phase = 'acting';
    else if (ev.type === 'end') p.phase = ev.status;
    const s = subs.get(t.id); if (s) for (const fn of s) { try { fn(ev); } catch { /* 訂閱端錯不影響任務 */ } }
  };

  // 澄清通道：job 呼叫 ask({question,options}) → 任務轉 needs-input、暫停,直到有人 answer()
  const makeAsk = (t) => ({ question, options }) => {
    t.status = 'needs-input'; t.pending = { question: String(question || ''), options: options || null };
    emit(t, { type: 'needs_input', question: t.pending.question, options: t.pending.options });
    return new Promise((resolve) => { t._answer = resolve; });
  };

  function pump() {
    while (active < concurrency && queue.length) {
      const t = queue.shift();
      active++;
      t.status = 'running'; t.startedAt = new Date().toISOString();
      emit(t, { type: 'status', status: 'running' });
      Promise.resolve()
        .then(() => runJob(t.spec, (ev) => emit(t, ev), makeAsk(t), (agent) => { t._agent = agent; }))
        .then((result) => { t.status = 'done'; t.result = result; })
        .catch((e) => { t.status = 'error'; t.error = e.message || String(e); })
        .finally(() => {
          if (t._cancelling && t.status !== 'error') t.status = 'cancelled'; // 使用者中斷
          t.finishedAt = new Date().toISOString();
          emit(t, { type: 'end', status: t.status, result: t.result, error: t.error });
          active--;
          try { onFinish?.(t); } catch { /* webhook 錯不影響佇列 */ }
          pump();
        });
    }
  }

  return {
    enqueue(spec) {
      const t = { id: newId('t'), status: 'queued', spec: spec || {}, events: [], result: null, error: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
      tasks.set(t.id, t);
      queue.push(t);
      pump();
      return t;
    },
    get: (id) => tasks.get(id),
    view: (id) => { const t = tasks.get(id); return t ? view(t) : null; },
    result: (id) => { const t = tasks.get(id); return t ? { ...view(t), result: t.result } : null; },
    list: () => [...tasks.values()].map(view),
    subscribe(id, fn) { let s = subs.get(id); if (!s) { s = new Set(); subs.set(id, s); } s.add(fn); return () => s.delete(fn); },
    // 中斷任務（取消鈕）：排隊中 → 直接移除；進行中 → abort agent；待答中 → 解除阻塞後 abort。
    cancel(id) {
      const t = tasks.get(id);
      if (!t || ['done', 'error', 'cancelled'].includes(t.status)) return false;
      t._cancelling = true;
      if (t.status === 'queued') {
        const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1);
        t.status = 'cancelled'; t.finishedAt = new Date().toISOString();
        emit(t, { type: 'end', status: 'cancelled' });
        return true;
      }
      if (typeof t._answer === 'function') { const r = t._answer; t._answer = null; t.pending = null; r(''); } // 解除待答阻塞
      if (t._agent && typeof t._agent.abort === 'function') { try { t._agent.abort(); } catch { /* 略 */ } }
      emit(t, { type: 'cancelling' });
      return true;
    },
    // 回答一個待答任務 → 解除暫停、續跑。回 true 表示有對應的待答問題。
    answer(id, text) {
      const t = tasks.get(id);
      if (!t || typeof t._answer !== 'function') return false;
      const resolve = t._answer; t._answer = null; t.pending = null; t.status = 'running';
      emit(t, { type: 'answered', answer: String(text ?? '') });
      resolve(String(text ?? ''));
      return true;
    },
    stats: () => ({ active, queued: queue.length, total: tasks.size }),
  };
}

/**
 * @param {Object} o
 * @param {object} o.model
 * @param {Function} o.getApiKey
 * @param {string} [o.token]        bearer token（未設＝不驗證，僅 PoC）
 * @param {string} [o.baseDir]      每個 session 的隔離工作目錄根
 * @param {boolean} [o.sandbox]     是否沙箱（預設 true：服務端跑 agent 應隔離）
 * @param {number} [o.concurrency]  背景任務同時數（預設 2）
 * @returns {import('node:http').Server}
 */
export function createServerApp({ model, getApiKey, token, baseDir = '.xitto-server', sandbox = true, concurrency = 2 } = {}) {
  const sessions = new Map(); // sessionId -> { pack, history }
  mkdirSync(baseDir, { recursive: true });

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  // header bearer 為主；img/iframe/下載這類瀏覽器發起的 GET 無法帶 header,允許 ?token=（同源、PoC）
  const authed = (req) => { if (!token) return true; if (req.headers.authorization === `Bearer ${token}`) return true; try { return new URL(req.url, 'http://x').searchParams.get('token') === token; } catch { return false; } };
  const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
  const sseHead = (res) => res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });

  // 共用：跑一輪/一目標，回傳 { sessionId, text, usage, rounds, done }；onEvent 收原始 kernel 事件；
  // ask（可選）= 澄清通道,讓 agent 在背景任務中暫停問使用者。
  async function runKernel(spec, onEvent, ask, onAgent) {
    const make = PACKS[spec.pack || 'general'];
    if (!make) throw new Error(`未知 pack「${spec.pack}」，可用：${Object.keys(PACKS).join(', ')}`);
    // 持久工作空間（B 模型）：workdir 綁 workspace（非 sessionId）→ 檔案留存 + 五層沉澱跨成品累積。
    const workspace = (spec.workspace || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    const workdir = join(baseDir, 'ws', workspace); mkdirSync(workdir, { recursive: true });
    // history 仍綁 sessionId（每個成品獨立對話：無 sessionId → 全新,不續接,避免 context 暴脹/混淆）
    const sessionId = spec.sessionId || newId();
    const sess = sessions.get(sessionId) || { history: [] };
    const kernel = createKernel(make({ cwd: workdir }), { cwd: workdir, model, getApiKey, sandbox: { enabled: sandbox }, getSandbox: () => sandbox, confirm: async () => 'yes', autoExtractMemory: true, ...(ask ? { askUser: ask } : {}) });
    const usage = { input: 0, output: 0 };
    const wrapped = (ev) => { if (ev.type === 'message_end' && ev.message?.usage) { usage.input += ev.message.usage.input || 0; usage.output += ev.message.usage.output || 0; } onEvent?.(ev); };
    if (spec.mode === 'goal') {
      // 結果導向：回傳交付物（做了什麼 + 產出的檔案 + 是否達成），對話只是過程
      const o = await kernel.runOutcome(spec.goal || spec.input || '', { history: sess.history, onEvent: wrapped, onAgent, onRound: (i) => wrapped({ type: 'round', round: i.round, maxRounds: i.maxRounds }) });
      sess.history = o.history || []; sessions.set(sessionId, sess);
      try { rmSync(join(workdir, 'tmp'), { recursive: true, force: true }); } catch { /* 清過程檔,失敗無妨 */ }
      return { sessionId, workspace, text: o.summary || lastText(sess.history), usage, rounds: o.rounds, done: o.done, aborted: o.aborted, artifacts: o.artifacts };
    }
    const r = await kernel.runTurn(spec.input || '', { history: sess.history, onEvent: wrapped, onAgent });
    sess.history = r.messages || r.history || []; sessions.set(sessionId, sess);
    return { sessionId, workspace, text: r.text ?? lastText(sess.history), usage, rounds: r.rounds, done: r.done };
  }

  // 完成通知：POST 結果到 spec.webhook（http/https），單次嘗試、失敗記日誌不重試（PoC）
  async function fireWebhook(task) {
    const url = task.spec.webhook; if (!url || !/^https?:\/\//.test(url)) return;
    const r = task.result || {};
    const body = JSON.stringify({ taskId: task.id, status: task.status, error: task.error, sessionId: r.sessionId, text: r.text, usage: r.usage, rounds: r.rounds, done: r.done, artifacts: r.artifacts, finishedAt: task.finishedAt });
    try { const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); log({ webhook: url, task: task.id, status: task.status, code: resp.status }); }
    catch (e) { log({ webhook: url, task: task.id, error: e.message }); }
  }

  const tasks = createTaskStore({
    concurrency,
    runJob: (spec, emit, ask, onAgent) => runKernel(spec, (ev) => { const m = mapEvent(ev); if (m) emit(m); }, ask, onAgent),
    onFinish: (task) => { log({ task: task.id, pack: task.spec.pack, mode: task.spec.mode || 'turn', status: task.status, ms: task.startedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : 0 }); fireWebhook(task); },
  });

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, packs: Object.keys(PACKS), model: model.id, tasks: tasks.stats() });

    // 「許願台」網頁（公開可載入；token 注入頁面供同源 API 呼叫——PoC/本地自用,正式部署請前置真實認證）
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      let html; try { html = webHtml(); } catch { return json(res, 500, { error: 'web UI 未找到' }); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html.replace(/__SERVER_TOKEN__/g, token || '').replace(/__PACKS__/g, JSON.stringify(Object.keys(PACKS))));
    }

    if (!authed(req)) return json(res, 401, { error: 'unauthorized（帶 Authorization: Bearer <token>）' });

    // 同步：跑完才回（JSON 或 SSE 串流）
    if (req.method === 'POST' && (path === '/v1/run' || path === '/v1/stream')) {
      const body = await readBody(req);
      const streaming = path === '/v1/stream';
      if (streaming) sseHead(res);
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const t0 = Date.now();
      try {
        const r = await runKernel(body, streaming ? (ev) => { const m = mapEvent(ev); if (m) sse(m); } : undefined);
        log({ pack: body.pack || 'general', session: r.sessionId, mode: body.mode || 'turn', tokens: r.usage.input + r.usage.output, rounds: r.rounds, ms: Date.now() - t0 });
        if (streaming) { sse({ type: 'done', ...r }); res.end(); } else json(res, 200, r);
      } catch (e) {
        log({ pack: body.pack, error: e.message });
        if (streaming) { sse({ type: 'error', error: e.message }); res.end(); } else json(res, e.message?.startsWith('未知 pack') ? 400 : 500, { error: e.message });
      }
      return;
    }

    // 背景任務：立刻回 taskId，後台跑，完成發 webhook
    if (req.method === 'POST' && path === '/v1/tasks') {
      const body = await readBody(req);
      if (!PACKS[body.pack || 'general']) return json(res, 400, { error: `未知 pack「${body.pack}」，可用：${Object.keys(PACKS).join(', ')}` });
      if (body.webhook && !/^https?:\/\//.test(body.webhook)) return json(res, 400, { error: 'webhook 需為 http(s) URL' });
      const t = tasks.enqueue({ pack: body.pack, mode: body.mode, input: body.input, goal: body.goal, sessionId: body.sessionId, webhook: body.webhook, workspace: body.workspace });
      log({ task: t.id, action: 'enqueue', pack: body.pack || 'general', mode: body.mode || 'turn' });
      return json(res, 202, { taskId: t.id, status: t.status, ...tasks.stats() });
    }
    if (req.method === 'GET' && path === '/v1/tasks') return json(res, 200, { tasks: tasks.list(), ...tasks.stats() });

    // 任務狀態 / 結果
    const mTask = path.match(/^\/v1\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && mTask) { const v = tasks.result(mTask[1]); return v ? json(res, 200, v) : json(res, 404, { error: 'task not found' }); }

    // 回答待答任務（澄清通道）：背景任務問了問題,使用者把答案送回 → 解除暫停、續跑
    const mAns = path.match(/^\/v1\/tasks\/([^/]+)\/answer$/);
    if (req.method === 'POST' && mAns) {
      const body = await readBody(req);
      const t = tasks.get(mAns[1]);
      if (!t) return json(res, 404, { error: 'task not found' });
      if (t.status !== 'needs-input') return json(res, 409, { error: '此任務目前沒有待答問題', status: t.status });
      tasks.answer(mAns[1], body.answer);
      log({ task: mAns[1], action: 'answer' });
      return json(res, 200, { ok: true, taskId: mAns[1], status: 'running' });
    }

    // 中斷任務（取消鈕）：控制權在使用者手上,降低「啟動了控制不了的東西」的焦慮
    const mCancel = path.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && mCancel) {
      const ok = tasks.cancel(mCancel[1]);
      log({ task: mCancel[1], action: 'cancel', ok });
      return ok ? json(res, 200, { ok: true, taskId: mCancel[1] }) : json(res, 409, { error: '無法中斷（任務不存在或已結束）' });
    }

    // 取交付物檔案內容（讓「成品」可被瀏覽/下載）
    const mFile = path.match(/^\/v1\/tasks\/([^/]+)\/file$/);
    if (req.method === 'GET' && mFile) {
      const t = tasks.get(mFile[1]); const ws = t?.result?.workspace;
      if (!ws) return json(res, 404, { error: '無交付物（任務尚未完成?）' });
      const rel = url.searchParams.get('path');
      const full = resolveArtifact(join(baseDir, 'ws', ws), rel);
      if (!full) return json(res, 400, { error: 'path 不合法' });
      if (!existsSync(full)) return json(res, 404, { error: '檔案不存在' });
      try {
        const ct = contentTypeFor(rel);
        const isText = /^text\/|json|xml|javascript|svg/.test(ct);
        const headers = { 'content-type': ct + (isText ? '; charset=utf-8' : '') };
        if (url.searchParams.get('download')) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(basename(rel))}"`;
        res.writeHead(200, headers); return res.end(readFileSync(full));
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    // 附掛背景任務的事件流（replay 緩衝 + 即時；已結束則回放後關閉）
    const mEv = path.match(/^\/v1\/tasks\/([^/]+)\/events$/);
    if (req.method === 'GET' && mEv) {
      const task = tasks.get(mEv[1]);
      if (!task) return json(res, 404, { error: 'task not found' });
      sseHead(res);
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      for (const ev of task.events) sse(ev);
      if (task.status === 'done' || task.status === 'error') { res.end(); return; }
      const unsub = tasks.subscribe(task.id, (ev) => { sse(ev); if (ev.type === 'end') { try { unsub(); } catch { /* 略 */ } res.end(); } });
      req.on('close', () => { try { unsub(); } catch { /* 略 */ } });
      return;
    }

    json(res, 404, { error: 'not found' });
  });
}

export function startServer() {
  const port = Number(process.env.PORT || 8787);
  const token = process.env.XITTO_SERVER_TOKEN || 'dev-token';
  const sandbox = process.env.XITTO_SERVER_SANDBOX !== 'off';
  const concurrency = Number(process.env.XITTO_SERVER_CONCURRENCY || 2);
  const { model, getApiKey } = loadModel(process.env.XITTO_MODEL);
  const server = createServerApp({ model, getApiKey, token, sandbox, concurrency });
  server.listen(port, () => {
    console.log(`🪄 許願台：http://localhost:${port}/  （瀏覽器打開即用——說出目標、交付成品）`);
    console.log(`xitto-kernel server · model ${model.id} · 沙箱 ${sandbox ? '開' : '關'} · 背景並發 ${concurrency}`);
    console.log(`token: ${token === 'dev-token' ? 'dev-token（請設 XITTO_SERVER_TOKEN）' : '(已設定)'}`);
    console.log('API：POST /v1/run · /v1/stream · /v1/tasks · /v1/tasks/:id/{answer,cancel}｜GET /v1/tasks[/:id[/events|/file]] · /health');
  });
  return server;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) startServer();
