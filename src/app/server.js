// Server app（PoC）— 把 kernel 包成 HTTP 服務（零依賴 node:http）。
// 證明 kernel 能脫離 CLI 跑成服務：bearer token 認證、per-session 隔離工作目錄、沙箱、結構化日誌、
// JSON 或 SSE 串流，以及「背景任務 + 完成通知（webhook）」—— 派任務出去、做完回呼，不用一直盯著。
// 這是「另一個 app 消費同一組 kernel 事件」—— 不動 kernel 核心。
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { createKernel } from '../kernel/index.js';
import { cacheRetentionFor } from '../kernel/provider.js';
import { createMemory } from '../kernel/memory.js';
import { createEpisodes } from '../kernel/episodes.js';
import { createSkills } from '../kernel/skills.js';
import { createPlaybook } from '../kernel/playbook.js';
import { fileAllowStore } from '../kernel/security/allow-store.js';
import { loadModel } from './providers.js';
import { createCodingPack } from '../packs/coding/index.js';
import { createDataQueryPack } from '../packs/data-query/index.js';
import { createNotesPack } from '../packs/notes/index.js';
import { createGeneralPack } from '../packs/general/index.js';
import { createDeepResearchPack } from '../packs/deep-research/index.js';
import { createDevopsPack } from '../packs/devops/index.js';
import { createPatentPack } from '../packs/patent/index.js';
import { isDocFile, extractDocText } from '../packs/shared/doc-extract.js';
import { createUiuxPack } from '../packs/uiux/index.js';

const PACKS = {
  coding: createCodingPack, 'data-query': createDataQueryPack, notes: createNotesPack,
  general: createGeneralPack, 'deep-research': createDeepResearchPack, devops: createDevopsPack,
  patent: createPatentPack, uiux: createUiuxPack,
};

const lastText = (history) => ([...(history || [])].reverse().find((m) => m.role === 'assistant')?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
const newId = (p = 's') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// 任務自動分流：非技術使用者不必懂「領域」，依願望文字自動挑最適合的 pack。
// LLM 為主、關鍵字 heuristic 為備援/逾時保險；任何不確定一律回 general（最通用，涵蓋八成需求）。
// 資源型 pack（data-query 需 DB、notes 需筆記庫）只在明確訊號才選，避免誤分流到跑不起來的領域。
const ROUTE_GUIDE =
  'general：通用（預設）。上網查資料、讀寫檔案、跑小腳本、串 API 的一般任務。不確定就選這個。\n' +
  'coding：改既有程式專案／repo——修 bug、跑測試、git。\n' +
  'deep-research：一個主題查多個來源、查證後寫成研究報告。\n' +
  'data-query：對 SQLite 資料庫下 SQL 撈數據——僅當明確提到資料庫／SQL／.db 才選。\n' +
  'notes：管理筆記知識庫——僅當明確提到筆記才選。\n' +
  'devops：伺服器維運／部署／docker／CI／常駐服務。\n' +
  'patent：撰寫專利交底書／找專利題目／挖掘發明點／現有技術初步檢索——提到專利／交底書／發明點時選。\n' +
  'uiux：設計或實作使用者介面——版面/排版、響應式/RWD、設計稿、CSS 樣式、可及性/a11y、視覺與互動設計時選。';

// 關鍵字快速判斷（LLM 不可用/逾時時的備援；命中強訊號才回領域，否則 null→general）。
export function heuristicPack(goal) {
  const g = String(goal || '').toLowerCase();
  if (/(sqlite|資料庫|database|\.db\b|撈數據|查詢資料表|\bsql\b|select\s+\*)/.test(g)) return 'data-query';
  if (/(部署|deploy|docker|kubernetes|k8s|nginx|ci\/cd|systemd|伺服器維運)/.test(g)) return 'devops';
  if (/(筆記本?|\bnotes?\b)/.test(g)) return 'notes';
  if (/(專利|专利|交底書?|交底书?|發明點|发明点|權利要求|权利要求|patent|invention\s*disclosure)/.test(g)) return 'patent';
  if (/(研究報告|深度研究|多來源|文獻|綜述|市場調查|競品分析|deep\s*research)/.test(g)) return 'deep-research';
  if (/(ui\s*\/?\s*ux|\buiux\b|介面設計|使用者介面|用戶界面|版面|排版|響應式|\brwd\b|設計稿|線框|wireframe|figma|無障礙|可及性|\ba11y\b|accessibility|視覺設計|設計系統|design\s*system|配色方案|design\s*token)/.test(g)) return 'uiux';
  if (/(修\s*bug|debug|重構|refactor|單元測試|unit\s*test|程式碼|codebase|\brepo\b|git\s*commit|pull\s*request|\.(js|ts|jsx|tsx|py|go|rs|java|cpp?|rb|php)\b)/.test(g)) return 'coding';
  return null;
}

// 回傳最適合的 pack 名（一定是 PACKS 內的合法 key）。complete 可注入（測試用），預設用 pi-ai completeSimple。
export async function classifyPack(goal, { model, getApiKey, complete = completeSimple } = {}) {
  const fallback = heuristicPack(goal) || 'general';
  if (!model || !getApiKey || !String(goal || '').trim()) return fallback;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000); // 分流不該拖慢交辦：逾時就用 heuristic
  try {
    const apiKey = await getApiKey(model.provider);
    if (!apiKey) return fallback;
    const ctx = {
      systemPrompt: '你是任務分流器。把使用者的需求分到最適合的「領域」，只輸出一個領域代號（general/coding/deep-research/data-query/notes/devops/patent/uiux）其中之一，不要解釋、不要標點。\n領域說明：\n' + ROUTE_GUIDE,
      messages: [{ role: 'user', content: [{ type: 'text', text: `需求：${String(goal).slice(0, 600)}\n\n領域代號是？` }], timestamp: Date.now() }],
    };
    const res = await complete(model, ctx, { maxTokens: 12, apiKey, signal: ac.signal, cacheRetention: cacheRetentionFor(model) });
    const t = (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').toLowerCase();
    const hit = Object.keys(PACKS).find((p) => t.includes(p)) || (t.includes('research') ? 'deep-research' : null);
    return hit || fallback;
  } catch { return fallback; }
  finally { clearTimeout(timer); }
}

// 交付檔案的 content-type（讓圖片能顯示、md/html 能渲染、其餘可下載）。
const MIME = { md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', py: 'text/plain', sh: 'text/plain', css: 'text/css', xml: 'application/xml', yaml: 'text/plain', yml: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export function contentTypeFor(name) { const ext = (String(name).split('.').pop() || '').toLowerCase(); return MIME[ext] || 'application/octet-stream'; }

// 工具參數摘要（給「展開過程」步驟卡）：取最有意義的參數。
const argSummary = (args) => { if (!args || typeof args !== 'object') return ''; const v = args.command ?? args.path ?? args.pattern ?? args.query ?? args.url ?? args.name ?? args.topic; return (v != null && v !== '') ? String(v).replace(/\s+/g, ' ').slice(0, 80) : ''; };

// workspace 名稱消毒（防穿越）。
export const safeWs = (w) => (String(w || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default');

// 解析 workspace → 真實目錄。本地模式 + 絕對路徑 → 就地用該真實資料夾（像 Claude Code）；
// 否則（含託管模式收到絕對路徑）→ 消毒成管理空間 ws/<name>，不會逃逸到主機任意路徑。
export function workspaceDir(baseDir, ws, local) {
  return (local && isAbsolute(String(ws || ''))) ? String(ws) : join(baseDir, 'ws', safeWs(ws));
}

// 列出可用磁碟（給 Windows 選夾器跨槽切換用）：探測 A:\ … Z:\ 是否存在。非 Windows 回空陣列。
// 無依賴、不走 shell；26 次 existsSync 很快。
export function listDrives() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (existsSync(d)) out.push(d); } catch { /* 略 */ } }
  return out;
}

// 確保 workdir 可用：指到既有檔案 → 拋錯（清楚理由,而非 mkdir 的 ENOTDIR）；不存在 → 自動建立。
// 與本地 CLI 的 resolveCwd 同規則,讓三條端點（/v1/tasks、/v1/run、/v1/stream）行為一致。
export function ensureWorkdir(dir) {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`工作目錄指到的不是資料夾：${dir}`);
    return dir;
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 列工作區檔案（給「工作台」分頁）：遞迴,排除內部目錄,回 [{path,size,mtime}]。
const SKIP_WS = new Set(['.xitto-kernel', 'node_modules', '.git', 'tmp', '.swebench-repos']);
export function listWorkspaceFiles(dir, base = dir, out = [], depth = 0) {
  if (depth > 8 || out.length > 2000) return out;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_WS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) listWorkspaceFiles(full, base, out, depth + 1);
    else if (e.isFile()) { try { const s = statSync(full); out.push({ path: relative(base, full), size: s.size, mtime: s.mtimeMs }); } catch { /* 略 */ } }
  }
  return out;
}

// 列單一層級（給工作台逐層瀏覽,不一次遞迴攤平整個專案）：回 { sub, dirs:[], files:[{name,size,mtime}] }。
export function listDir(wsDir, sub) {
  const rel = String(sub || '').replace(/^\/+|\/+$/g, '');
  const dir = rel === '' ? wsDir : resolveArtifact(wsDir, rel);
  if (!dir || !existsSync(dir)) return null;
  const dirs = [], files = [];
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (SKIP_WS.has(e.name)) continue;
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) { try { const s = statSync(join(dir, e.name)); files.push({ name: e.name, size: s.size, mtime: s.mtimeMs }); } catch { /* 略 */ } }
  }
  return { sub: rel, dirs: dirs.sort(), files: files.sort((a, b) => b.mtime - a.mtime) };
}

// 讀一個 workspace 累積的「五層經驗」（跨 pack 聚合）→ 給 Wishboard 視覺化「它對你的了解」。
// 純讀不寫（各 store 構造只讀檔，不會建檔/落地）。回傳事實/手冊/技能/情節/信任 + 計數。
const _tsNum = (t) => (typeof t === 'number' ? t : Date.parse(t) || 0);
export function readWorkspaceExperience(wsDir) {
  const root = join(wsDir, '.xitto-kernel');
  const out = { packs: [], memory: [], playbook: [], skills: [], episodes: [], trust: { tools: [], bash: [] }, counts: {} };
  let packDirs = [];
  if (existsSync(root)) {
    try { packDirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 略 */ }
  }
  const memSeen = new Set(), trustTools = new Set(), trustBash = new Set();
  for (const pack of packDirs) {
    const d = join(root, pack); let had = false;
    try { for (const m of createMemory(join(d, 'memory.md')).list()) { had = true; if (!memSeen.has(m)) { memSeen.add(m); out.memory.push(m); } } } catch { /* 略 */ }
    try { for (const e of createPlaybook(join(d, 'playbook.md')).list()) { out.playbook.push({ ...e, pack }); had = true; } } catch { /* 略 */ }
    try { for (const s of createSkills(join(d, 'skills')).list()) { out.skills.push({ ...s, pack }); had = true; } } catch { /* 略 */ }
    try { for (const ep of createEpisodes(join(d, 'episodes.jsonl')).list(50)) { out.episodes.push({ ...ep, pack }); had = true; } } catch { /* 略 */ }
    try { const t = fileAllowStore(join(d, 'allow.json')).list(); t.tools.forEach((x) => trustTools.add(x)); t.bash.forEach((x) => trustBash.add(x)); if (t.tools.length || t.bash.length) had = true; } catch { /* 略 */ }
    if (had) out.packs.push(pack);
  }
  out.episodes.sort((a, b) => _tsNum(b.ts) - _tsNum(a.ts));
  out.episodes = out.episodes.slice(0, 30);
  out.trust = { tools: [...trustTools], bash: [...trustBash] };
  out.counts = { memory: out.memory.length, playbook: out.playbook.length, skills: out.skills.length, episodes: out.episodes.length, trust: trustTools.size + trustBash.size };
  return out;
}

// 交付檔案路徑解析（防穿越）：rel 必須是 workdir 內的相對路徑,否則回 null。
export function resolveArtifact(workdir, rel) {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel)) return null;
  const full = join(workdir, rel);
  const r = relative(workdir, full);
  return (r.startsWith('..') || isAbsolute(r)) ? null : full;
}

let _webHtml;
const webHtml = () => (_webHtml ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'web', 'index.html'), 'utf8'));
let _chatHtml;
const chatHtml = () => (_chatHtml ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'web', 'chat.html'), 'utf8'));

// 把原始 kernel 事件壓成精簡的對外事件（串流端與背景任務共用，避免重複映射）
export const mapEvent = (ev) => {
  if (ev.type === 'tool_execution_start') return { type: 'tool', name: ev.toolName, args: ev.args };
  if (ev.type === 'tool_execution_end') return { type: 'tool_end', name: ev.toolName, isError: !!ev.isError, diff: ev.result?._diff || undefined };
  // 子 agent（spawn_agent）內部工具活動：嵌套顯示在父步驟底下
  if (ev.type === 'tool_execution_update' && ev.partialResult?.kind === 'subagent') {
    const p = ev.partialResult;
    if (p.phase === 'end') return { type: 'sub_tool_end', name: p.name, isError: !!p.isError };
    if (p.phase === 'think') return { type: 'sub_think', text: p.text || '' };
    return { type: 'sub_tool', name: p.name, args: p.args };
  }
  if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') return { type: 'text', delta: ev.assistantMessageEvent.delta };
  if (ev.type === 'round') return { type: 'round', round: ev.round, maxRounds: ev.maxRounds };
  if (ev.type === 'verify_start') return { type: 'phase', phase: 'verifying' };
  if (ev.type === 'verify_end') return { type: 'phase', phase: ev.ok ? 'verified' : 'fixing' };
  // token 用量（每則訊息結束結算）：給 UI 即時顯示累計 token（像 Claude Code 的進度列）
  if (ev.type === 'message_end' && ev.message?.usage) return { type: 'usage', input: ev.message.usage.input || 0, output: ev.message.usage.output || 0 };
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
export function createTaskStore({ runJob, concurrency = 2, onFinish, maxEvents = 500, persistDir } = {}) {
  const tasks = new Map();   // id -> task
  const queue = [];          // 等待中的 task
  const subs = new Map();    // id -> Set<(ev)=>void>
  let active = 0;

  // 持久化：每個任務落地一個 json（重啟後歷史成品還在）。runtime 欄位（_agent/events…）不存。
  const snapshot = (t) => ({ id: t.id, status: t.status, spec: t.spec, result: t.result, error: t.error, createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt, progress: t.progress || null, pending: t.pending || null });
  const persistTask = (t) => { if (!persistDir) return; try { mkdirSync(persistDir, { recursive: true }); writeFileSync(join(persistDir, t.id + '.json'), JSON.stringify(snapshot(t))); } catch { /* 略 */ } };
  if (persistDir && existsSync(persistDir)) {
    for (const f of readdirSync(persistDir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const t = JSON.parse(readFileSync(join(persistDir, f), 'utf8'));
        if (['running', 'queued', 'needs-input'].includes(t.status)) { t.status = 'interrupted'; t.pending = null; } // 進程已死 → 標中斷
        t.events = [];
        tasks.set(t.id, t);
      } catch { /* 壞檔略 */ }
    }
  }

  const view = (t) => ({ taskId: t.id, status: t.status, pack: t.spec.pack || 'general', auto: !!t.spec.auto, mode: t.spec.mode || 'turn', workspace: t.spec.workspace || 'default', goal: t.spec.goal || t.spec.input || '', sessionId: t.result?.sessionId || t.spec.sessionId || null, continued: !!t.spec.sessionId, createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error, pending: t.pending || null, progress: t.progress || null });

  const emit = (t, ev) => {
    t.events.push(ev);
    if (t.events.length > maxEvents) t.events.shift();
    // 進度追蹤（給 UI 顯示「正在做什麼」,不要只顯示進行中；排除 text 雜訊）
    const p = (t.progress ||= { steps: 0, round: 0, maxRounds: 0, recent: [], phase: 'starting', thinking: '', todos: [], log: [] });
    if (ev.type === 'tool' && ev.name === 'todo_write') { if (Array.isArray(ev.args?.todos)) p.todos = ev.args.todos; } // 待辦清單（給 UI 打勾）
    else if (ev.type === 'tool') {
      p.steps++; p.phase = 'acting'; p.thinking = ''; t._textbuf = '';
      p.recent.push({ name: ev.name, args: ev.args }); if (p.recent.length > 6) p.recent.shift();
      if (p.log.length < 100) p.log.push({ name: ev.name, summary: argSummary(ev.args) }); // 完整步驟（給「展開過程」）
    } else if (ev.type === 'tool_end') {
      const last = p.log[p.log.length - 1];
      if (last && last.name === ev.name && !('isError' in last)) { last.isError = ev.isError; if (ev.diff) last.diff = ev.diff; }
    }
    else if (ev.type === 'text') { p.phase = 'thinking'; t._textbuf = ((t._textbuf || '') + (ev.delta || '')).slice(-400); p.thinking = t._textbuf.replace(/\s+/g, ' ').trim().slice(-150); }
    else if (ev.type === 'round') { p.round = ev.round; if (ev.maxRounds) p.maxRounds = ev.maxRounds; p.thinking = ''; t._textbuf = ''; }
    else if (ev.type === 'phase') p.phase = ev.phase;
    else if (ev.type === 'steered') { (p.steers ||= []).push(ev.text); if (p.steers.length > 8) p.steers.shift(); } // 使用者中途補充（給 UI 回饋「已收到」）
    else if (ev.type === 'needs_input') p.phase = 'needs-input';
    else if (ev.type === 'answered') p.phase = 'acting';
    else if (ev.type === 'end') p.phase = ev.status;
    const s = subs.get(t.id); if (s) for (const fn of s) { try { fn(ev); } catch { /* 訂閱端錯不影響任務 */ } }
  };

  // 澄清通道：job 呼叫 ask({question,options}) → 任務轉 needs-input、暫停,直到有人 answer()
  const makeAsk = (t) => ({ question, options }) => {
    t.status = 'needs-input'; t.pending = { question: String(question || ''), options: options || null };
    emit(t, { type: 'needs_input', question: t.pending.question, options: t.pending.options });
    persistTask(t);
    return new Promise((resolve) => { t._answer = resolve; });
  };

  function pump() {
    while (active < concurrency && queue.length) {
      const t = queue.shift();
      active++;
      t.status = 'running'; t.startedAt = new Date().toISOString();
      emit(t, { type: 'status', status: 'running' });
      Promise.resolve()
        .then(() => runJob(t.spec, (ev) => emit(t, ev), makeAsk(t), (agent) => { t._agent = agent; }, () => { const b = t.steerBuf || []; t.steerBuf = []; return b; }))
        .then((result) => { t.status = 'done'; t.result = result; })
        .catch((e) => { t.status = 'error'; t.error = e.message || String(e); })
        .finally(() => {
          if (t._cancelling && t.status !== 'error') t.status = 'cancelled'; // 使用者中斷
          t.finishedAt = new Date().toISOString();
          emit(t, { type: 'end', status: t.status, result: t.result, error: t.error });
          persistTask(t);
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
      persistTask(t);
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
        emit(t, { type: 'end', status: 'cancelled' }); persistTask(t);
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
      emit(t, { type: 'answered', answer: String(text ?? '') }); persistTask(t);
      resolve(String(text ?? ''));
      return true;
    },
    // 中途補充（steering）：任務進行中,使用者插話。agent 正在串流 → 即時排進 steeringQueue（下個 turn 邊界生效,不中斷當前工具）；
    // 回合之間（goal loop 的 checkGoal 空檔,agent 已收尾）→ 緩衝到 task,由 kernel 下一輪 drainSteer 折進指令。兩路互斥,不重複套用。
    steer(id, text) {
      const t = tasks.get(id);
      if (!t || t.status !== 'running') return false;
      const msg = String(text ?? '').trim();
      if (!msg) return false;
      const live = !!(t._agent && t._agent.state && t._agent.state.isStreaming);
      if (live) { try { t._agent.steer({ role: 'user', content: [{ type: 'text', text: msg }] }); } catch { (t.steerBuf ||= []).push(msg); } }
      else (t.steerBuf ||= []).push(msg);
      emit(t, { type: 'steered', text: msg, queued: !live });
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
export function createServerApp({ model, getApiKey, token, baseDir = '.xitto-server', sandbox = true, concurrency = 2, local = false } = {}) {
  const sessions = new Map(); // sessionId -> { history }
  mkdirSync(baseDir, { recursive: true });

  // 對話 session 持久化（讓「繼續/調整」跨重啟可用）：啟動載回 + 每次更新落地。
  const sessDir = join(baseDir, 'sessions');
  try { if (existsSync(sessDir)) for (const f of readdirSync(sessDir).filter((x) => x.endsWith('.json'))) { try { sessions.set(f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(sessDir, f), 'utf8'))); } catch { /* 略 */ } } } catch { /* 略 */ }
  const persistSession = (id, sess) => { try { mkdirSync(sessDir, { recursive: true }); writeFileSync(join(sessDir, id + '.json'), JSON.stringify({ history: sess.history })); } catch { /* 略 */ } };

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  // header bearer 為主；img/iframe/下載這類瀏覽器發起的 GET 無法帶 header,允許 ?token=（同源、PoC）
  const authed = (req) => { if (!token) return true; if (req.headers.authorization === `Bearer ${token}`) return true; try { return new URL(req.url, 'http://x').searchParams.get('token') === token; } catch { return false; } };
  const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
  const sseHead = (res) => res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  // 依副檔名給 content-type 回傳檔案（圖片顯示/md 渲染/下載皆走這）。
  const serveFile = (res, full, rel, download, asText) => {
    if (!existsSync(full)) return json(res, 404, { error: '檔案不存在' });
    try {
      // ?as=text 且為 Word/Excel/PPT/PDF 等文件 → 萃取成純文字回傳（給網頁預覽；下載仍走原檔）
      if (asText && !download && isDocFile(full)) {
        try {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end(extractDocText(full));
        } catch (e) { return json(res, 422, { error: '文件解析失敗', detail: e.message }); }
      }
      const ct = contentTypeFor(rel);
      const isText = /^text\/|json|xml|javascript|svg/.test(ct);
      const headers = { 'content-type': ct + (isText ? '; charset=utf-8' : '') };
      if (download) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(basename(rel))}"`;
      res.writeHead(200, headers); return res.end(readFileSync(full));
    } catch (e) { return json(res, 500, { error: e.message }); }
  };

  // 共用：跑一輪/一目標，回傳 { sessionId, text, usage, rounds, done }；onEvent 收原始 kernel 事件；
  // ask（可選）= 澄清通道,讓 agent 在背景任務中暫停問使用者。
  async function runKernel(spec, onEvent, ask, onAgent, drainSteer) {
    const make = PACKS[spec.pack || 'general'];
    if (!make) throw new Error(`未知 pack「${spec.pack}」，可用：${Object.keys(PACKS).join(', ')}`);
    // 持久工作空間（B 模型）：workdir 綁 workspace（非 sessionId）→ 檔案留存 + 五層沉澱跨成品累積。
    // 本地模式 + workspace 是絕對路徑 → 就地用該真實資料夾（像 Claude Code 改你現有的檔）。
    const workspace = spec.workspace || 'default';
    const workdir = workspaceDir(baseDir, workspace, local); ensureWorkdir(workdir);
    // history 仍綁 sessionId（每個成品獨立對話：無 sessionId → 全新,不續接,避免 context 暴脹/混淆）
    const sessionId = spec.sessionId || newId();
    const sess = sessions.get(sessionId) || { history: [] };
    const kernel = createKernel(make({ cwd: workdir }), { cwd: workdir, model, getApiKey, sandbox: { enabled: sandbox }, getSandbox: () => sandbox, confirm: async () => 'yes', autoExtractMemory: true, ...(ask ? { askUser: ask } : {}) });
    const usage = { input: 0, output: 0 };
    const wrapped = (ev) => { if (ev.type === 'message_end' && ev.message?.usage) { usage.input += ev.message.usage.input || 0; usage.output += ev.message.usage.output || 0; } onEvent?.(ev); };
    if (spec.mode === 'goal') {
      // 結果導向：回傳交付物（做了什麼 + 產出的檔案 + 是否達成），對話只是過程
      const o = await kernel.runOutcome(spec.goal || spec.input || "", { maxRounds: 8, history: sess.history, onEvent: wrapped, onAgent, drainSteer, onRound: (i) => wrapped({ type: 'round', round: i.round, maxRounds: i.maxRounds }) });
      sess.history = o.history || []; sessions.set(sessionId, sess); persistSession(sessionId, sess);
      try { rmSync(join(workdir, 'tmp'), { recursive: true, force: true }); } catch { /* 清過程檔,失敗無妨 */ }
      // 溯源：邏輯位置 workspace 永遠記；實體路徑只在本地模式給（託管不洩漏伺服器路徑）
      return { sessionId, workspace, workspaceDir: local ? resolve(workdir) : undefined, text: o.summary || lastText(sess.history), usage, rounds: o.rounds, done: o.done, aborted: o.aborted, artifacts: o.artifacts };
    }
    const r = await kernel.runTurn(spec.input || '', { history: sess.history, onEvent: wrapped, onAgent });
    sess.history = r.messages || r.history || []; sessions.set(sessionId, sess); persistSession(sessionId, sess);
    return { sessionId, workspace, workspaceDir: local ? resolve(workdir) : undefined, text: r.text ?? lastText(sess.history), usage, rounds: r.rounds, done: r.done };
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
    persistDir: join(baseDir, 'tasks'),
    runJob: (spec, emit, ask, onAgent, drainSteer) => runKernel(spec, (ev) => { const m = mapEvent(ev); if (m) emit(m); }, ask, onAgent, drainSteer),
    onFinish: (task) => { log({ task: task.id, pack: task.spec.pack, mode: task.spec.mode || 'turn', status: task.status, ms: task.startedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : 0 }); fireWebhook(task); },
  });

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, packs: Object.keys(PACKS), model: model.id, tasks: tasks.stats() });

    // favicon（公開，免 auth）：瀏覽器會自動抓 /favicon.ico，沒這條會被 auth 擋成 401。回一個內嵌 SVG 標誌。
    if (req.method === 'GET' && (path === '/favicon.ico' || path === '/favicon.svg')) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#5b63e6"/><g fill="#fff"><path d="M11 21l8-8 1.6 1.6-8 8z" opacity=".95"/><path d="M20 9l.7 1.8L22.5 11.5l-1.8.7L20 14l-.7-1.8L17.5 11.5l1.8-.7z"/><circle cx="12" cy="11" r="1"/><circle cx="23" cy="19" r="1"/></g></svg>';
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' });
      return res.end(svg);
    }

    // 靜態檔案（CSS / JS / 字體等）：從 web/shared/ 提供，與 HTML token 替換分開處理。
    if (req.method === 'GET' && path.startsWith('/shared/')) {
      const file = join(dirname(fileURLToPath(import.meta.url)), 'web', path);
      if (!existsSync(file)) return json(res, 404, { error: 'not found' });
      const ext = path.split('.').pop() || '';
      const ct = contentTypeFor(path);
      const isText = /^text\/|json|xml|javascript|svg/.test(ct);
      res.writeHead(200, { 'content-type': ct + (isText ? '; charset=utf-8' : '') });
      return res.end(readFileSync(file));
    }

    // 「許願台」網頁（公開可載入；token 注入頁面供同源 API 呼叫——PoC/本地自用,正式部署請前置真實認證）
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      let html; try { html = webHtml(); } catch { return json(res, 500, { error: 'web UI 未找到' }); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html.replace(/__SERVER_TOKEN__/g, token || '').replace(/__PACKS__/g, JSON.stringify(Object.keys(PACKS))).replace(/__LOCAL__/g, local ? 'true' : 'false'));
    }

    // 「對話」網頁：同一 kernel 的另一個前端——對話式（mode:turn + 固定 sessionId 多輪、SSE 串流），
    // 與許願台（mode:goal、交付物導向）做出區別。共用同一組工作區（五層沉澱跨頁累積）。
    if (req.method === 'GET' && (path === '/chat' || path === '/chat.html')) {
      let html; try { html = chatHtml(); } catch { return json(res, 500, { error: 'chat UI 未找到' }); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html.replace(/__SERVER_TOKEN__/g, token || '').replace(/__PACKS__/g, JSON.stringify(Object.keys(PACKS))).replace(/__LOCAL__/g, local ? 'true' : 'false'));
    }

    if (!authed(req)) return json(res, 401, { error: 'unauthorized（帶 Authorization: Bearer <token>）' });

    // 同步：跑完才回（JSON 或 SSE 串流）
    if (req.method === 'POST' && (path === '/v1/run' || path === '/v1/stream')) {
      const body = await readBody(req);
      if (!body.pack || body.pack === 'auto') body.pack = await classifyPack(body.goal || body.input || '', { model, getApiKey }); // 自動分流
      const streaming = path === '/v1/stream';
      if (streaming) sseHead(res);
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const t0 = Date.now();
      // 串流「停止」：client 按停止 → abort fetch → 連線關閉 → 中止 kernel 回合,不再空跑伺服器資源。
      // 經 onAgent 取得執行中的 agent（同背景任務 /cancel 的 agent.abort() 機制）。
      let agentRef = null, clientGone = false;
      const onAgent = streaming ? (a) => { agentRef = a; if (clientGone && a?.abort) { try { a.abort(); } catch { /* 略 */ } } } : undefined;
      // 偵測 client 斷線（按「停止」）用 res 'close'（串流回應的斷線在 res 上才可靠，req 'close' 不會觸發）
      if (streaming) res.on('close', () => { clientGone = true; if (agentRef?.abort) { try { agentRef.abort(); } catch { /* 略 */ } } });
      try {
        const r = await runKernel(body, streaming ? (ev) => { const m = mapEvent(ev); if (m) sse(m); } : undefined, undefined, onAgent);
        if (clientGone) return; // 已斷線：history 已在 runKernel 內落地,這裡不再寫回應
        log({ pack: body.pack || 'general', session: r.sessionId, mode: body.mode || 'turn', tokens: r.usage.input + r.usage.output, rounds: r.rounds, ms: Date.now() - t0 });
        if (streaming) { sse({ type: 'done', ...r }); res.end(); } else json(res, 200, r);
      } catch (e) {
        if (clientGone) return;
        log({ pack: body.pack, error: e.message });
        if (streaming) { sse({ type: 'error', error: e.message }); res.end(); } else json(res, /^未知 pack|工作目錄/.test(e.message || '') ? 400 : 500, { error: e.message });
      }
      return;
    }

    // 背景任務：立刻回 taskId，後台跑，完成發 webhook
    if (req.method === 'POST' && path === '/v1/tasks') {
      const body = await readBody(req);
      // 自動分流：pack 省略或為 'auto' → 依願望文字挑領域（非技術使用者不必懂領域）。
      let pack = body.pack; let routed = false;
      if (!pack || pack === 'auto') { pack = await classifyPack(body.goal || body.input || '', { model, getApiKey }); routed = true; }
      if (!PACKS[pack]) return json(res, 400, { error: `未知 pack「${body.pack}」，可用：${Object.keys(PACKS).join(', ')}` });
      if (body.webhook && !/^https?:\/\//.test(body.webhook)) return json(res, 400, { error: 'webhook 需為 http(s) URL' });
      // 本地絕對路徑：缺失自動建立（與 CLI 一致），指到既有檔案才 fail-fast 報錯。
      if (local && body.workspace && isAbsolute(body.workspace)) {
        try { ensureWorkdir(body.workspace); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      const t = tasks.enqueue({ pack, mode: body.mode, input: body.input, goal: body.goal, sessionId: body.sessionId, webhook: body.webhook, workspace: body.workspace, auto: routed });
      log({ task: t.id, action: 'enqueue', pack, routed, mode: body.mode || 'turn' });
      return json(res, 202, { taskId: t.id, status: t.status, pack, routed, ...tasks.stats() });
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

    // 中途補充（steering）：任務進行中,使用者插話調整方向/補需求。排隊注入,不中斷當前工作,下個邊界生效。
    const mSteer = path.match(/^\/v1\/tasks\/([^/]+)\/steer$/);
    if (req.method === 'POST' && mSteer) {
      const body = await readBody(req);
      const t = tasks.get(mSteer[1]);
      if (!t) return json(res, 404, { error: 'task not found' });
      if (t.status !== 'running') return json(res, 409, { error: '只有進行中的任務可以補充', status: t.status });
      const ok = tasks.steer(mSteer[1], body.text);
      if (!ok) return json(res, 400, { error: '補充內容為空或無法送出' });
      log({ task: mSteer[1], action: 'steer' });
      return json(res, 200, { ok: true, taskId: mSteer[1] });
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
      const full = resolveArtifact(workspaceDir(baseDir, ws, local), rel);
      if (!full) return json(res, 400, { error: 'path 不合法' });
      return serveFile(res, full, rel, url.searchParams.get('download'), url.searchParams.get('as') === 'text');
    }

    // 資料夾瀏覽器（僅本地模式）：列某路徑下的子資料夾,給網頁「用選的」挑真實資料夾
    if (req.method === 'GET' && path === '/v1/fs') {
      if (!local) return json(res, 403, { error: '僅本地模式可瀏覽資料夾' });
      // 導覽用 base + name/up，由伺服器端 join/dirname 拼接(跨平台；避免前端把含反斜線的 Windows 絕對路徑
      // 塞進 JS 字串而被跳脫吃掉分隔符)。name=進入子資料夾、up=1=上一層、皆無則用 base 或家目錄。
      const baseParam = url.searchParams.get('path');
      const name = url.searchParams.get('name');
      const dir = (baseParam && name) ? join(resolve(baseParam), name)
        : (baseParam && url.searchParams.get('up') === '1') ? dirname(resolve(baseParam))
          : resolve(baseParam || homedir());
      const showHidden = url.searchParams.get('hidden') === '1'; // 預設藏 dot 開頭；前端勾「顯示隱藏資料夾」才帶 hidden=1
      try {
        const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules' && (showHidden || !e.name.startsWith('.'))).map((e) => e.name).sort();
        return json(res, 200, { path: dir, parent: dirname(dir), home: homedir(), dirs, drives: listDrives() });
      } catch (e) { return json(res, 400, { error: '無法讀取：' + e.message }); }
    }

    // 工作台：逐層列檔（sub=子目錄,不一次遞迴攤平整個專案；ws 走 query 以容納本地絕對路徑）
    if (req.method === 'GET' && path === '/v1/workspaces/files') {
      const dir = workspaceDir(baseDir, url.searchParams.get('ws') || 'default', local);
      return json(res, 200, listDir(dir, url.searchParams.get('sub') || '') || { sub: '', dirs: [], files: [] });
    }
    // 工作區累積的「五層經驗」（給 Wishboard 視覺化「它越用越懂你」——Claude Code 沒有的差異點）
    if (req.method === 'GET' && path === '/v1/workspaces/experience') {
      const dir = workspaceDir(baseDir, url.searchParams.get('ws') || 'default', local);
      try { return json(res, 200, readWorkspaceExperience(dir)); }
      catch (e) { return json(res, 200, { packs: [], memory: [], playbook: [], skills: [], episodes: [], trust: { tools: [], bash: [] }, counts: { memory: 0, playbook: 0, skills: 0, episodes: 0, trust: 0 }, error: e.message }); }
    }
    // 工作台：取檔（看/下載）/ 刪檔
    if (path === '/v1/workspaces/file' && (req.method === 'GET' || req.method === 'DELETE')) {
      const dir = workspaceDir(baseDir, url.searchParams.get('ws') || 'default', local);
      const rel = url.searchParams.get('path');
      const full = resolveArtifact(dir, rel);
      if (!full) return json(res, 400, { error: 'path 不合法' });
      if (req.method === 'DELETE') {
        try { if (existsSync(full)) rmSync(full); log({ action: 'delete', path: rel }); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 500, { error: e.message }); }
      }
      return serveFile(res, full, rel, url.searchParams.get('download'), url.searchParams.get('as') === 'text');
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

// opts 優先於環境變數；未給則沿用 env / 預設（向後相容原本的 env-only 啟動）。
// 可傳入已載入的 { model, getApiKey }（CLI serve 用），否則由 loadModel 依 providers.json 載入。
export function startServer(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 8787);
  const token = opts.token ?? process.env.XITTO_SERVER_TOKEN ?? 'dev-token';
  const sandbox = opts.sandbox ?? (process.env.XITTO_SERVER_SANDBOX !== 'off');
  const concurrency = Number(opts.concurrency ?? process.env.XITTO_SERVER_CONCURRENCY ?? 2);
  const local = opts.local ?? (process.env.XITTO_SERVER_LOCAL === '1' || process.env.XITTO_SERVER_LOCAL === 'true');
  const { model, getApiKey } = (opts.model && opts.getApiKey) ? opts : loadModel(opts.modelId ?? process.env.XITTO_MODEL);
  const server = createServerApp({ model, getApiKey, token, sandbox, concurrency, local });
  server.listen(port, () => {
    console.log(`🪄 許願台：http://localhost:${port}/  （瀏覽器打開即用——說出目標、交付成品）`);
    console.log(`xitto-kernel server · model ${model.id} · 沙箱 ${sandbox ? '開' : '關'} · 背景並發 ${concurrency}${local ? ' · 本地模式(顯示檔案位置)' : ''}`);
    console.log(`token: ${token === 'dev-token' ? 'dev-token（請設 XITTO_SERVER_TOKEN）' : '(已設定)'}`);
    console.log('API：POST /v1/run · /v1/stream · /v1/tasks · /v1/tasks/:id/{answer,steer,cancel}｜GET /v1/tasks[/:id[/events|/file]] · /health');
  });
  return server;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) startServer();
