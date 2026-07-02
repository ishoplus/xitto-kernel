// Server app（PoC）— 把 kernel 包成 HTTP 服務（零依賴 node:http）。
// 證明 kernel 能脫離 CLI 跑成服務：bearer token 認證、per-session 隔離工作目錄、沙箱、結構化日誌、
// JSON 或 SSE 串流，以及「背景任務 + 完成通知（webhook）」—— 派任務出去、做完回呼，不用一直盯著。
// 這是「另一個 app 消費同一組 kernel 事件」—— 不動 kernel 核心。
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, networkInterfaces } from 'node:os';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { createKernel } from '../kernel/index.js';
import { cacheRetentionFor } from '../kernel/provider.js';
import { createMemory } from '../kernel/memory.js';
import { createEpisodes } from '../kernel/episodes.js';
import { createSkills } from '../kernel/skills.js';
import { createPlaybook } from '../kernel/playbook.js';
import { fileAllowStore } from '../kernel/security/allow-store.js';
import { loadModel, buildModel, providersConfigPath, loadProvidersConfig } from './providers.js';
import { createCodingPack } from '../packs/coding/index.js';
import { createDataQueryPack } from '../packs/data-query/index.js';
import { createNotesPack } from '../packs/notes/index.js';
import { createGeneralPack } from '../packs/general/index.js';
import { createDeepResearchPack } from '../packs/deep-research/index.js';
import { createDevopsPack } from '../packs/devops/index.js';
import { createPatentPack } from '../packs/patent/index.js';
import { isDocFile, extractDocText } from '../packs/shared/doc-extract.js';
import { createUiuxPack } from '../packs/uiux/index.js';
import { createDocgenPack } from '../packs/docgen/index.js';

const PACKS = {
  coding: createCodingPack, 'data-query': createDataQueryPack, notes: createNotesPack,
  general: createGeneralPack, 'deep-research': createDeepResearchPack, devops: createDevopsPack,
  patent: createPatentPack, uiux: createUiuxPack, docgen: createDocgenPack,
};

const lastText = (history) => ([...(history || [])].reverse().find((m) => m.role === 'assistant')?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
const newId = (p = 's') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// 不可猜的 token（邀請碼 / 成員憑證用）：優先 crypto，退回雙 newId 拼接。
const newToken = () => (globalThis.crypto?.randomUUID?.() || (newId('k') + newId('k'))).replace(/-/g, '');

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
  'uiux：設計或實作使用者介面——版面/排版、響應式/RWD、設計稿、CSS 樣式、可及性/a11y、視覺與互動設計時選。\n' +
  'docgen：把內容產成可交付文件檔——PDF／Word(docx)／CSV／HTML，提到要「一份報告/文件/PDF/Word/簡報式文件/匯出成檔」時選。';

// 關鍵字快速判斷（LLM 不可用/逾時時的備援；命中強訊號才回領域，否則 null→general）。
export function heuristicPack(goal) {
  const g = String(goal || '').toLowerCase();
  if (/(sqlite|資料庫|database|\.db\b|撈數據|查詢資料表|\bsql\b|select\s+\*)/.test(g)) return 'data-query';
  if (/(部署|deploy|docker|kubernetes|k8s|nginx|ci\/cd|systemd|伺服器維運)/.test(g)) return 'devops';
  if (/(筆記本?|\bnotes?\b)/.test(g)) return 'notes';
  if (/(專利|专利|交底書?|交底书?|發明點|发明点|權利要求|权利要求|patent|invention\s*disclosure)/.test(g)) return 'patent';
  if (/(研究報告|深度研究|多來源|文獻|綜述|市場調查|競品分析|deep\s*research)/.test(g)) return 'deep-research';
  if (/(ui\s*\/?\s*ux|\buiux\b|介面設計|使用者介面|用戶界面|版面|排版|響應式|\brwd\b|設計稿|線框|wireframe|figma|無障礙|可及性|\ba11y\b|accessibility|視覺設計|設計系統|design\s*system|配色方案|design\s*token)/.test(g)) return 'uiux';
  if (/(\bpdf\b|\bdocx?\b|word\s*檔|\bcsv\b|產(出|生).*(報告|文件|檔)|做一?份.*(報告|文件|簡報)|匯出成?\s*(pdf|word|檔|csv)|export\s*(to\s*)?(pdf|docx|csv))/.test(g)) return 'docgen';
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
      systemPrompt: '你是任務分流器。把使用者的需求分到最適合的「領域」，只輸出一個領域代號（general/coding/deep-research/data-query/notes/devops/patent/uiux/docgen）其中之一，不要解釋、不要標點。\n領域說明：\n' + ROUTE_GUIDE,
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

// 區網 IPv4（給啟動訊息與邀請連結：讓同網段的其他機器能連進來）。回 [] 表示只有 loopback。
export function lanIPs() {
  const out = [];
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      // family 在新版 Node 是 'IPv4'，舊版是 4；兩者都收。排除內部（loopback）與 link-local（169.254.*）。
      const isV4 = ni.family === 'IPv4' || ni.family === 4;
      if (isV4 && !ni.internal && !ni.address.startsWith('169.254.')) out.push(ni.address);
    }
  }
  return out;
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

// 房間上傳/建夾的相對路徑組裝：sub 是當前瀏覽子目錄，name 取 basename（剝掉任何路徑段，擋穿越）
// → 回 "sub/name"（單一末節點）；名稱空/為 . / .. 一律回 null（真正的越界仍由 resolveArtifact 再擋一層）。
export function joinUploadRel(sub, name) {
  const fname = basename(String(name || '').trim());
  if (!fname || fname === '.' || fname === '..') return null;
  const s = String(sub || '').replace(/^\/+|\/+$/g, '');
  return (s ? s + '/' : '') + fname;
}

let _webHtml;
const webHtml = () => (_webHtml ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'web', 'index.html'), 'utf8'));
let _chatHtml;
const chatHtml = () => (_chatHtml ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'web', 'chat.html'), 'utf8'));
let _roomHtml;
const roomHtml = () => (_roomHtml ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'web', 'room.html'), 'utf8'));

// 把原始 kernel 事件壓成精簡的對外事件（串流端與背景任務共用，避免重複映射）
export const mapEvent = (ev) => {
  // 串流一開始就送 sessionId → 前端可即時把「全新對話」登進側欄，切走後仍能切回看它續播
  if (ev.type === 'session_start') return { type: 'session', sessionId: ev.sessionId };
  if (ev.type === 'tool_execution_start') return { type: 'tool', name: ev.toolName, args: ev.args };
  if (ev.type === 'tool_execution_end') return { type: 'tool_end', name: ev.toolName, isError: !!ev.isError, diff: ev.result?._diff || undefined };
  // 子 agent（spawn_agent）內部工具活動：嵌套顯示在父步驟底下
  if (ev.type === 'tool_execution_update' && ev.partialResult?.kind === 'subagent') {
    const p = ev.partialResult;
    if (p.phase === 'end') return { type: 'sub_tool_end', name: p.name, isError: !!p.isError };
    if (p.phase === 'think') return { type: 'sub_think', text: p.text || '' };
    return { type: 'sub_tool', name: p.name, args: p.args };
  }
  // spawn_agents 平行 map 的逐項進度 → 嵌套在 spawn_agents 步驟下顯示
  if (ev.type === 'tool_execution_update' && ev.partialResult?.kind === 'mapagent') {
    const p = ev.partialResult;
    const name = `項目 ${p.index + 1}/${p.total}`;
    return p.phase === 'item_done'
      ? { type: 'sub_tool_end', name, isError: !!p.isError }
      : { type: 'sub_tool', name, args: { task: p.task } };
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

// 「@ai」召喚判定：訊息點名 AI 才觸發回覆（多人閒聊不燒 token）。
// 允許行首或前面接空白/全形空白/標點，避免 email 之類的 @ai 誤觸太寬；大小寫不拘。
export const mentionsAi = (text) => /(^|[\s(（【「,，。、!！?？])@ai\b/i.test(String(text || ''));

/**
 * 專案會議室（多人 + LLM 同一對話）。純記憶體 + 可選持久化，與 HTTP 無關、可單測。
 * 一間房 = 共享 workspace（五層經驗累積）+ 共享對話 history（綁 sessionId）+ 成員 + 訊息流。
 * 人類發言即時廣播給全員；只有點名「@ai」才餵給 LLM 回覆（回合制，不重疊）。
 * @param {Object} o
 * @param {(args:{room:object,input:string,emit:(ev:object)=>void,onAgent:(a:any)=>void})=>Promise<any>} o.runAiTurn  跑一輪 AI（回傳 { sessionId, text, ... }）
 * @param {string} [o.persistDir]   每間房落地一個 json（重啟後房間與訊息還在；成員為即時態不存）
 * @param {number} [o.maxMessages]  每房保留最近幾則訊息（replay 用，預設 300）
 * @param {number} [o.maxPending]   兩次 AI 回合之間最多累積幾則作為上下文（預設 50）
 */
export function createRoomStore({ runAiTurn, persistDir, maxMessages = 300, maxPending = 50 } = {}) {
  const rooms = new Map();  // id -> room
  const subs = new Map();   // id -> Set<(ev)=>void>

  const snapshot = (r) => ({ id: r.id, name: r.name || '', workspace: r.workspace, pack: r.pack, model: r.model || null, readonly: !!r.readonly, sessionId: r.sessionId, inviteToken: r.inviteToken, messages: r.messages, createdAt: r.createdAt });
  const persist = (r) => { if (!persistDir) return; try { mkdirSync(persistDir, { recursive: true }); writeFileSync(join(persistDir, r.id + '.json'), JSON.stringify(snapshot(r))); } catch { /* 略 */ } };
  if (persistDir && existsSync(persistDir)) {
    for (const f of readdirSync(persistDir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const s = JSON.parse(readFileSync(join(persistDir, f), 'utf8'));
        rooms.set(s.id, { ...s, messages: s.messages || [], members: new Map(), pending: [], status: 'idle', agentRef: null });
      } catch { /* 壞檔略 */ }
    }
  }

  const memberNames = (r) => [...r.members.values()].map((m) => m.name);
  const view = (r) => ({ roomId: r.id, name: r.name || '', workspace: r.workspace, pack: r.pack, model: r.model || null, readonly: !!r.readonly, sessionId: r.sessionId || null, status: r.status, members: memberNames(r), memberCount: r.members.size, messageCount: r.messages.length, createdAt: r.createdAt });

  const fanout = (r, ev) => { const s = subs.get(r.id); if (s) for (const fn of s) { try { fn(ev); } catch { /* 訂閱端錯不影響房間 */ } } };
  // 記錄一則訊息（人類/AI/系統）進 replay buffer 並廣播。
  const push = (r, msg) => {
    const m = { id: newId('m'), ts: new Date().toISOString(), ...msg };
    r.messages.push(m); if (r.messages.length > maxMessages) r.messages.shift();
    fanout(r, { type: 'say', message: m });
    return m;
  };

  const fmtPending = (msgs) => msgs.map((m) => `[${m.name}] ${m.text}`).join('\n');

  // 跑一輪 AI：把待處理發言（含召喚那則）整理成一段上下文餵給 LLM；回合制，跑完若又有新的 @ai 就續跑。
  async function runNow(r) {
    if (r.status === 'thinking') return;
    r.status = 'thinking'; fanout(r, { type: 'status', status: 'thinking' }); persist(r);
    const batch = r.pending.splice(0, r.pending.length);
    const input = fmtPending(batch);
    let finalText = '';
    const emit = (ev) => { if (ev?.type === 'text') finalText += ev.delta || ''; fanout(r, { type: 'ai', ev }); };
    const onAgent = (a) => { r.agentRef = a; };
    try {
      const res = await runAiTurn({ room: r, input, emit, onAgent });
      if (res?.sessionId) r.sessionId = res.sessionId; // 首輪建立 → 之後續接同一對話
      const text = (res?.text ?? finalText) || '';
      push(r, { kind: 'ai', name: 'AI', text });
    } catch (e) {
      push(r, { kind: 'system', name: 'system', text: 'AI 回覆失敗：' + (e?.message || String(e)) });
    } finally {
      r.agentRef = null;
      r.status = 'idle'; fanout(r, { type: 'status', status: 'idle' }); persist(r);
      // 回合中若又有人 @ai（新累積的 pending 含召喚）→ 立刻續跑，確保每次召喚終會被回覆。
      if (r.pending.some((m) => m.mention)) runNow(r);
    }
  }

  return {
    create({ workspace = 'default', pack = 'general', model = null, name = '', readonly = false } = {}) {
      // inviteToken：房間專屬邀請碼（放進邀請連結，不再外洩 master token）。name：人類可讀會議名（可空，前端回退顯示 workspace）。
      // readonly：訪客唯讀（只能看檔案+聊天+@ai，不能上傳/建夾）；主持人（master）不受限。
      // model：此房 AI 回合用的 model（null=用伺服器預設）；與 pack 正交，可事後 setModel 切換。
      const nm = String(name || '').trim().slice(0, 60);
      const r = { id: newId('r'), name: nm, workspace, pack, model: model || null, readonly: !!readonly, sessionId: null, inviteToken: newToken(), members: new Map(), messages: [], pending: [], status: 'idle', agentRef: null, createdAt: new Date().toISOString() };
      rooms.set(r.id, r); persist(r);
      return { ...view(r), inviteToken: r.inviteToken }; // 建房者才拿得到 inviteToken
    },
    // 切換此房 model（master only，路由層把關）：下一輪 AI 回合起生效，並廣播讓成員 UI 同步。
    // 注意：同一對話續接時歷史會重新序列化成新 provider 格式（跨 provider 切換的已知風險，見 P2）。
    setModel(id, modelId) {
      const r = rooms.get(id); if (!r) return null;
      r.model = modelId || null; persist(r);
      fanout(r, { type: 'room_model', model: r.model });
      push(r, { kind: 'system', name: 'system', text: r.model ? `模型已切換為 ${r.model}（下一輪生效）` : '模型已切回伺服器預設' });
      return view(r);
    },
    get: (id) => rooms.get(id),
    view: (id) => { const r = rooms.get(id); return r ? view(r) : null; },
    snapshot: (id) => { const r = rooms.get(id); return r ? snapshot(r) : null; },
    // 列房（master only）：帶 inviteToken，讓 operator 大廳能直接複製各房邀請連結。
    list: () => [...rooms.values()].map((r) => ({ ...view(r), inviteToken: r.inviteToken })),
    // 換發邀請碼（撤銷舊連結）；只有 master 能呼叫（在路由層把關）。
    rotateInvite(id) { const r = rooms.get(id); if (!r) return null; r.inviteToken = newToken(); persist(r); return r.inviteToken; },
    // 關閉房間（master only，在路由層把關）：廣播 room_closed 讓在線成員退場 → 斷所有 SSE → 刪落地 json →
    // 回傳該房 sessionId 供呼叫端聯刪 session（避免孤兒 history）。已無此房回 null。
    remove(id) {
      const r = rooms.get(id); if (!r) return null;
      const sessionId = r.sessionId;
      fanout(r, { type: 'room_closed', roomId: id });
      const s = subs.get(id); if (s) { s.clear(); subs.delete(id); }
      rooms.delete(id);
      if (persistDir) { try { rmSync(join(persistDir, id + '.json'), { force: true }); } catch { /* 略 */ } }
      return { ok: true, sessionId };
    },
    // 加入房間 → 發 memberId + 專屬成員 token（後續發言/收流的憑證，區分身分、防冒名）+ 廣播進場。
    join(id, name) {
      const r = rooms.get(id); if (!r) return null;
      const memberId = newId('u');
      const nm = String(name || '').trim().slice(0, 40) || '訪客';
      const memberToken = newToken();
      r.members.set(memberId, { name: nm, joinedAt: Date.now(), token: memberToken });
      // 帶完整名單 → 既有成員的前端直接重繪清單（不只更新人數）。
      fanout(r, { type: 'member_join', name: nm, members: memberNames(r), memberCount: r.members.size });
      return { memberId, name: nm, memberToken };
    },
    leave(id, memberId) {
      const r = rooms.get(id); if (!r) return false;
      const m = r.members.get(memberId); if (!m) return false;
      r.members.delete(memberId);
      fanout(r, { type: 'member_leave', name: m.name, members: memberNames(r), memberCount: r.members.size });
      return true;
    },
    // 發言：立刻廣播給全員 + 進 AI 上下文佇列；點名 @ai 才觸發（或合併進進行中的回合，回合末續跑）。
    say(id, { memberId, text }) {
      const r = rooms.get(id); if (!r) return { error: 'room not found', code: 404 };
      const m = r.members.get(memberId); if (!m) return { error: '請先加入房間', code: 403 };
      const msg = String(text ?? '').trim(); if (!msg) return { error: '發言不可為空', code: 400 };
      const mention = mentionsAi(msg);
      push(r, { kind: 'user', name: m.name, text: msg });
      r.pending.push({ name: m.name, text: msg, mention });
      while (r.pending.length > maxPending) r.pending.shift(); // 上限保護（保留最近，含召喚）
      persist(r);
      if (mention && r.status === 'idle') runNow(r);
      return { ok: true, triggered: mention, status: r.status };
    },
    subscribe(id, fn) { let s = subs.get(id); if (!s) { s = new Set(); subs.set(id, s); } s.add(fn); return () => s.delete(fn); },
    stats: () => ({ roomCount: rooms.size }),
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
export function createServerApp({ model, getApiKey, resolveModel, models = [], token, baseDir = '.xitto-server', sandbox = true, concurrency = 2, local = false, publicOrigin = '', configPath, onReconfigure } = {}) {
  // 可選 model 清單（跨 provider）：給 /v1/models 與「未知 model」錯誤訊息用；始終含當前預設 model。
  const modelList = (models && models.length) ? models : [{ id: model.id, name: model.name || model.id, provider: model.provider }];
  const knownModel = (id) => !id || id === model.id || modelList.some((m) => m.id === id);
  const sessions = new Map(); // sessionId -> { history }
  mkdirSync(baseDir, { recursive: true });

  // 對話 session 持久化（讓「繼續/調整」跨重啟可用）：啟動載回 + 每次更新落地。
  const sessDir = join(baseDir, 'sessions');
  try { if (existsSync(sessDir)) for (const f of readdirSync(sessDir).filter((x) => x.endsWith('.json'))) { try { sessions.set(f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(sessDir, f), 'utf8'))); } catch { /* 略 */ } } } catch { /* 略 */ }
  const persistSession = (id, sess) => { try { mkdirSync(sessDir, { recursive: true }); writeFileSync(join(sessDir, id + '.json'), JSON.stringify({ history: sess.history })); } catch { /* 略 */ } };
  // 刪除 session（內存 + 落地）：關房時聯刪其對話 history，避免孤兒 session 檔累積。
  const dropSession = (id) => { if (!id) return; sessions.delete(id); try { rmSync(join(sessDir, id + '.json'), { force: true }); } catch { /* 略 */ } };

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  // header bearer 為主；img/iframe/下載這類瀏覽器發起的 GET 無法帶 header,允許 ?token=（同源、PoC）
  // 取出請求帶的 bearer（header 為主；瀏覽器發起的 GET/SSE 無法帶 header → 允許 ?token=）。
  const bearerOf = (req) => {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    try { return new URL(req.url, 'http://x').searchParams.get('token'); } catch { return null; }
  };
  const authed = (req) => !token || bearerOf(req) === token;
  // 房間層授權（比 master 更細）：master 一律通過（operator override）；未設 master → 全開（本地自用）。
  // 否則憑該房的邀請碼 / 成員 token：need='join'→邀請碼；'member'→成員 token；'read'→兩者皆可。
  const roomAuth = (req, room, need) => {
    if (authed(req)) return { ok: true, master: true };
    const t = bearerOf(req); if (!t) return { ok: false };
    for (const [mid, m] of room.members) if (m.token === t) return { ok: true, memberId: mid, member: m };
    if ((need === 'join' || need === 'read') && t === room.inviteToken) return { ok: true, invite: true };
    return { ok: false };
  };
  const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
  // 上傳原始 bytes（不解析 JSON）：超過上限即停止緩衝並斷流 → 回 { over:true }，否則 { buffer }。
  const MAX_UPLOAD = Number(process.env.XITTO_MAX_UPLOAD || 50 * 1024 * 1024); // 預設 50MB/檔
  const readRaw = (req, max = MAX_UPLOAD) => new Promise((resolve) => {
    const chunks = []; let len = 0, over = false, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      len += c.length;
      if (len > max) { over = true; if (len > max * 8) req.destroy(); return; } // 超限即停止緩衝（仍讀到底以便回 413）；極端濫用才斷流
      chunks.push(c);
    });
    req.on('end', () => finish(over ? { over: true } : { buffer: Buffer.concat(chunks) }));
    req.on('close', () => finish(over ? { over: true } : { buffer: Buffer.concat(chunks) }));
    req.on('error', () => finish({ over }));
  });
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
    // model 與 pack 正交：pack 決定「做什麼」，model 決定「誰來做」。spec.model 覆蓋預設（回落 resolveModel）。
    // getApiKey 是 provider-aware（buildResolver）→ 切到別 provider 的 model 也會取對的 key。
    let runModel = model;
    if (spec.model && spec.model !== model.id) {
      runModel = (typeof resolveModel === 'function' && resolveModel(spec.model)) || null;
      if (!runModel) throw new Error(`未知 model「${spec.model}」，可用：${modelList.map((m) => m.id).join(', ')}`);
    }
    // 持久工作空間（B 模型）：workdir 綁 workspace（非 sessionId）→ 檔案留存 + 五層沉澱跨成品累積。
    // 本地模式 + workspace 是絕對路徑 → 就地用該真實資料夾（像 Claude Code 改你現有的檔）。
    const workspace = spec.workspace || 'default';
    const workdir = workspaceDir(baseDir, workspace, local); ensureWorkdir(workdir);
    // history 仍綁 sessionId（每個成品獨立對話：無 sessionId → 全新,不續接,避免 context 暴脹/混淆）
    const sessionId = spec.sessionId || newId();
    const sess = sessions.get(sessionId) || { history: [] };
    const kernel = createKernel(make({ cwd: workdir }), { cwd: workdir, model: runModel, getApiKey, resolveModel, sandbox: { enabled: sandbox }, getSandbox: () => sandbox, confirm: async () => 'yes', autoExtractMemory: true, ...(ask ? { askUser: ask } : {}) });
    const usage = { input: 0, output: 0 };
    onEvent?.({ type: 'session_start', sessionId }); // 串流首事件：讓前端立刻知道此輪的 sessionId
    const wrapped = (ev) => { if (ev.type === 'message_end' && ev.message?.usage) { usage.input += ev.message.usage.input || 0; usage.output += ev.message.usage.output || 0; } onEvent?.(ev); };
    if (spec.mode === 'goal') {
      // 結果導向：回傳交付物（做了什麼 + 產出的檔案 + 是否達成），對話只是過程
      const o = await kernel.runOutcome(spec.goal || spec.input || "", { maxRounds: 8, history: sess.history, onEvent: wrapped, onAgent, drainSteer, onRound: (i) => wrapped({ type: 'round', round: i.round, maxRounds: i.maxRounds }) });
      sess.history = o.history || []; sessions.set(sessionId, sess); persistSession(sessionId, sess);
      try { rmSync(join(workdir, 'tmp'), { recursive: true, force: true }); } catch { /* 清過程檔,失敗無妨 */ }
      // 溯源：邏輯位置 workspace 永遠記；實體路徑只在本地模式給（託管不洩漏伺服器路徑）
      return { sessionId, workspace, model: runModel.id, workspaceDir: local ? resolve(workdir) : undefined, text: o.summary || lastText(sess.history), usage, rounds: o.rounds, done: o.done, aborted: o.aborted, artifacts: o.artifacts, verify: o.verify || null };
    }
    const r = await kernel.runTurn(spec.input || '', { history: sess.history, onEvent: wrapped, onAgent });
    sess.history = r.messages || r.history || []; sessions.set(sessionId, sess); persistSession(sessionId, sess);
    return { sessionId, workspace, model: runModel.id, workspaceDir: local ? resolve(workdir) : undefined, text: r.text ?? lastText(sess.history), stopReason: r.stopReason, usage, rounds: r.rounds, done: r.done, verify: r.verify || null };
  }

  // 完成通知：POST 結果到 spec.webhook（http/https），單次嘗試、失敗記日誌不重試（PoC）
  async function fireWebhook(task) {
    const url = task.spec.webhook; if (!url || !/^https?:\/\//.test(url)) return;
    const r = task.result || {};
    const body = JSON.stringify({ taskId: task.id, status: task.status, error: task.error, sessionId: r.sessionId, text: r.text, usage: r.usage, rounds: r.rounds, done: r.done, verify: r.verify, artifacts: r.artifacts, finishedAt: task.finishedAt });
    try { const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); log({ webhook: url, task: task.id, status: task.status, code: resp.status }); }
    catch (e) { log({ webhook: url, task: task.id, error: e.message }); }
  }

  const tasks = createTaskStore({
    concurrency,
    persistDir: join(baseDir, 'tasks'),
    runJob: (spec, emit, ask, onAgent, drainSteer) => runKernel(spec, (ev) => { const m = mapEvent(ev); if (m) emit(m); }, ask, onAgent, drainSteer),
    onFinish: (task) => { log({ task: task.id, pack: task.spec.pack, mode: task.spec.mode || 'turn', status: task.status, ms: task.startedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : 0 }); fireWebhook(task); },
  });

  // 把發言裡的 @file(相對路徑) 引用展開成檔案內容，附在餵給 LLM 的 input 後面（讓 AI 能讀被點名的檔）。
  // 只讀本房 workspace（resolveArtifact 防穿越）、純文字、每檔截斷、總量設頂；找不到就略過。
  const expandFileRefs = (text, wsDir) => {
    const rels = [...new Set([...String(text).matchAll(/@file\(([^)]+)\)/g)].map((m) => m[1].trim()))];
    let extra = '', budget = 40000;
    for (const rel of rels) {
      const full = resolveArtifact(wsDir, rel);
      if (!full || !existsSync(full)) continue;
      try { if (!statSync(full).isFile()) continue; const c = readFileSync(full, 'utf8').slice(0, Math.max(0, Math.min(12000, budget))); if (!c) continue; extra += `\n\n--- 引用檔案：${rel} ---\n${c}`; budget -= c.length; if (budget <= 0) break; } catch { /* 二進位/讀取失敗略過 */ }
    }
    return extra ? text + extra : text;
  };

  // 專案會議室：多人 + LLM 同一對話（共享 workspace/history）。AI 回合走同一個 runKernel（turn 模式），
  // 只在有人 @ai 時觸發；房間 sessionId 綁定 → 續接同一 history（跨回合、跨重啟）。
  const rooms = createRoomStore({
    persistDir: join(baseDir, 'rooms'),
    runAiTurn: ({ room, input, emit, onAgent }) =>
      runKernel({ pack: room.pack, model: room.model || undefined, mode: 'turn', input: expandFileRefs(input, workspaceDir(baseDir, room.workspace, local)), workspace: room.workspace, sessionId: room.sessionId || undefined },
        (ev) => { const m = mapEvent(ev); if (m) emit(m); }, undefined, onAgent),
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

    // 「會議室」網頁：主控台 vs 訪客兩種載入。
    // 主控台（無 ?room=）：注入 master token，可建房（operator 專用 URL，請自行前置保護/勿外流）。
    // 訪客（帶 ?room=，即邀請連結）：不注入 master token，只憑 URL 上的邀請碼加入 → 換得成員 token。
    if (req.method === 'GET' && (path === '/room' || path === '/room.html')) {
      let html; try { html = roomHtml(); } catch { return json(res, 500, { error: 'room UI 未找到' }); }
      const guest = url.searchParams.has('room');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // __PUBLIC_ORIGIN__：伺服器建議的對外網址（區網 IP / 域名）→ host 在 localhost 開頁時，邀請連結改用它。
      return res.end(html.replace(/__SERVER_TOKEN__/g, guest ? '' : (token || '')).replace(/__PACKS__/g, JSON.stringify(Object.keys(PACKS))).replace(/__LOCAL__/g, local ? 'true' : 'false').replace(/__PUBLIC_ORIGIN__/g, () => publicOrigin || ''));
    }

    // ── 專案會議室（房間層授權：建房/列房需 master；房內動作憑邀請碼/成員 token）──
    // 建房（master only）→ 回 inviteToken（放進邀請連結分享）；列房（master only，operator 總覽）
    if (req.method === 'POST' && path === '/v1/rooms') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      let pack = body.pack; if (!pack || pack === 'auto') pack = 'general';
      if (!PACKS[pack]) return json(res, 400, { error: `未知 pack「${body.pack}」，可用：${Object.keys(PACKS).join(', ')}` });
      const rmodel = body.model && body.model !== model.id ? String(body.model) : null;
      if (rmodel && !knownModel(rmodel)) return json(res, 400, { error: `未知 model「${rmodel}」，可用：${modelList.map((m) => m.id).join(', ')}` });
      if (local && body.workspace && isAbsolute(body.workspace)) {
        try { ensureWorkdir(body.workspace); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      const v = rooms.create({ workspace: body.workspace || 'default', pack, model: rmodel, name: body.name, readonly: !!body.readonly });
      log({ room: v.roomId, action: 'create', pack, model: rmodel || undefined, workspace: v.workspace, name: v.name || undefined, readonly: v.readonly || undefined });
      return json(res, 201, v);
    }
    if (req.method === 'GET' && path === '/v1/rooms') { if (!authed(req)) return json(res, 401, { error: 'unauthorized' }); return json(res, 200, { rooms: rooms.list(), ...rooms.stats() }); }
    // 可選 model 清單（給前端建房/切換選單）：需 master（模型配置屬 operator 範疇）。default 標記當前預設。
    if (req.method === 'GET' && path === '/v1/models') { if (!authed(req)) return json(res, 401, { error: 'unauthorized' }); return json(res, 200, { models: modelList, default: model.id }); }

    // 設定入口（master only）：復用引導頁，改成「新增/更新一個 provider」語境。POST /v1/setup 合併進既有 providers.json 後熱重載。
    if (req.method === 'GET' && path === '/settings') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      // 現有設定 → 注入頁面（不含 apiKey，避免外洩）：[{provider,api,models:[{id,name,default}]}]。
      let existing = [];
      try {
        const cfg = loadProvidersConfig(providersConfigPath(configPath));
        existing = Object.entries(cfg.providers || {}).map(([provider, p]) => ({
          provider, api: p.api || 'openai-completions',
          models: (p.models || []).map((m) => ({ id: m.id, name: m.name || m.id, default: m.id === cfg.defaultModel })),
        }));
      } catch { /* 尚無檔 → 空清單 */ }
      const html = SETUP_HTML
        .replace('<h1>初始設定</h1>', '<h1>模型設定</h1>')
        .replace(/尚未偵測到 provider 設定（<code>providers.json<\/code>）。填入要用的模型服務，儲存後服務會自動啟動——不需要重進容器。/, '在此新增或更新模型服務（provider / model）。既有設定不會被覆蓋；儲存後服務自動重載，可繼續新增。')
        .replace('/*EXISTING*/null', JSON.stringify(existing));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (req.method === 'POST' && path === '/v1/setup') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const cfgPath = providersConfigPath(configPath);
      let base = null; try { base = loadProvidersConfig(cfgPath); } catch { /* 尚無檔 → 等同新建 */ }
      let cfg; try { cfg = mergeSetupConfig(base, body); buildModel(cfg, cfg.defaultModel); } catch (e) { return json(res, 400, { error: e.message }); }
      try { mkdirSync(dirname(cfgPath), { recursive: true }); writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); }
      catch (e) { return json(res, 500, { error: '寫入設定失敗：' + e.message }); }
      log({ action: 'reconfigure', provider: Object.keys(body.provider ? { [body.provider]: 1 } : {})[0], model: body.modelId });
      json(res, 200, { ok: true, path: cfgPath, reload: !!onReconfigure });
      // 回應送達後熱重載（close 現有 server → 用同 opts 重起，載入新設定）。無 onReconfigure（如注入式啟動）則需手動重啟。
      if (onReconfigure) setTimeout(() => { try { onReconfigure(); } catch (e) { console.error('熱重載失敗：', e.message); } }, 300);
      return;
    }

    // 換發邀請碼（撤銷舊連結；master only）
    const mRotate = path.match(/^\/v1\/rooms\/([^/]+)\/invite$/);
    if (req.method === 'POST' && mRotate) {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      const t = rooms.rotateInvite(mRotate[1]);
      return t ? json(res, 200, { inviteToken: t }) : json(res, 404, { error: 'room not found' });
    }

    // 切換此房 model（master only）：body.model=null/'' → 回落伺服器預設。下一輪 AI 回合起生效。
    const mModel = path.match(/^\/v1\/rooms\/([^/]+)\/model$/);
    if (req.method === 'POST' && mModel) {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const want = body.model && body.model !== model.id ? String(body.model) : null;
      if (want && !knownModel(want)) return json(res, 400, { error: `未知 model「${want}」，可用：${modelList.map((m) => m.id).join(', ')}` });
      const v = rooms.setModel(mModel[1], want);
      if (!v) return json(res, 404, { error: 'room not found' });
      log({ room: mModel[1], action: 'set-model', model: want || 'default' });
      return json(res, 200, v);
    }

    // 關閉房間（master only）：斷所有 SSE、廣播 room_closed 讓在線成員退場，聯刪其對話 session（避免孤兒 history）。
    const mDelRoom = path.match(/^\/v1\/rooms\/([^/]+)$/);
    if (req.method === 'DELETE' && mDelRoom) {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      const r = rooms.remove(mDelRoom[1]);
      if (!r) return json(res, 404, { error: 'room not found' });
      dropSession(r.sessionId);
      log({ room: mDelRoom[1], action: 'remove' });
      return json(res, 200, { ok: true });
    }

    // 房間快照（讀取：邀請碼或成員 token 皆可）
    const mRoom = path.match(/^\/v1\/rooms\/([^/]+)$/);
    if (req.method === 'GET' && mRoom) {
      const room = rooms.get(mRoom[1]); if (!room) return json(res, 404, { error: 'room not found' });
      if (!roomAuth(req, room, 'read').ok) return json(res, 401, { error: '需要邀請碼或成員 token' });
      return json(res, 200, { ...rooms.view(mRoom[1]), messages: rooms.snapshot(mRoom[1]).messages });
    }

    // 加入房間（憑邀請碼）→ 回專屬成員 token（後續發言/收流的憑證）
    const mJoin = path.match(/^\/v1\/rooms\/([^/]+)\/join$/);
    if (req.method === 'POST' && mJoin) {
      const room = rooms.get(mJoin[1]); if (!room) return json(res, 404, { error: 'room not found' });
      if (!roomAuth(req, room, 'join').ok) return json(res, 401, { error: '邀請碼無效' });
      const body = await readBody(req);
      const r = rooms.join(mJoin[1], body.name);
      log({ room: mJoin[1], action: 'join', name: r.name });
      return json(res, 200, { ...r, ...rooms.view(mJoin[1]) });
    }

    // 離開房間（憑成員 token；由 token 推導 memberId，不吃 body 冒名）
    const mLeave = path.match(/^\/v1\/rooms\/([^/]+)\/leave$/);
    if (req.method === 'POST' && mLeave) {
      const room = rooms.get(mLeave[1]); if (!room) return json(res, 404, { error: 'room not found' });
      const auth = roomAuth(req, room, 'member'); if (!auth.ok) return json(res, 401, { error: '需要成員 token' });
      const memberId = auth.memberId || (await readBody(req)).memberId;
      const ok = rooms.leave(mLeave[1], memberId);
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'member not found' });
    }

    // 發言（憑成員 token；發言者身分由 token 決定 → 無法冒名）。@ai 才觸發 LLM。
    const mSay = path.match(/^\/v1\/rooms\/([^/]+)\/say$/);
    if (req.method === 'POST' && mSay) {
      const room = rooms.get(mSay[1]); if (!room) return json(res, 404, { error: 'room not found' });
      const auth = roomAuth(req, room, 'member'); if (!auth.ok) return json(res, 401, { error: '需要成員 token' });
      const body = await readBody(req);
      const r = rooms.say(mSay[1], { memberId: auth.memberId || body.memberId, text: body.text });
      if (r.error) return json(res, r.code || 400, { error: r.error });
      log({ room: mSay[1], action: 'say', triggered: r.triggered });
      return json(res, 200, r);
    }

    // 房間事件流（SSE，憑邀請碼或成員 token）：即時收「他人發言 + AI 串流 + 成員進出 + 狀態」；連上先回放近況。
    const mRoomEv = path.match(/^\/v1\/rooms\/([^/]+)\/events$/);
    if (req.method === 'GET' && mRoomEv) {
      const room = rooms.get(mRoomEv[1]); if (!room) return json(res, 404, { error: 'room not found' });
      if (!roomAuth(req, room, 'read').ok) return json(res, 401, { error: '需要邀請碼或成員 token' });
      sseHead(res);
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      sse({ type: 'hello', room: rooms.view(mRoomEv[1]) });
      for (const m of rooms.snapshot(mRoomEv[1]).messages) sse({ type: 'say', message: m, replay: true });
      const unsub = rooms.subscribe(mRoomEv[1], (ev) => sse(ev));
      req.on('close', () => { try { unsub(); } catch { /* 略 */ } });
      return;
    }

    // 房間工作區檔案（档案目录）：逐層列檔，限本房 workspace（憑邀請碼/成員 token）。
    const mRoomFiles = path.match(/^\/v1\/rooms\/([^/]+)\/files$/);
    if (req.method === 'GET' && mRoomFiles) {
      const room = rooms.get(mRoomFiles[1]); if (!room) return json(res, 404, { error: 'room not found' });
      if (!roomAuth(req, room, 'read').ok) return json(res, 401, { error: '需要邀請碼或成員 token' });
      const dir = workspaceDir(baseDir, room.workspace, local);
      return json(res, 200, listDir(dir, url.searchParams.get('sub') || '') || { sub: '', dirs: [], files: [] });
    }
    // 取房間工作區單檔（看/下載；憑邀請碼/成員 token，防穿越，限本房 workspace）。
    const mRoomFile = path.match(/^\/v1\/rooms\/([^/]+)\/file$/);
    if (req.method === 'GET' && mRoomFile) {
      const room = rooms.get(mRoomFile[1]); if (!room) return json(res, 404, { error: 'room not found' });
      if (!roomAuth(req, room, 'read').ok) return json(res, 401, { error: '需要邀請碼或成員 token' });
      const rel = url.searchParams.get('path');
      const full = resolveArtifact(workspaceDir(baseDir, room.workspace, local), rel);
      if (!full) return json(res, 400, { error: 'path 不合法' });
      return serveFile(res, full, rel, url.searchParams.get('download'), url.searchParams.get('as') === 'text');
    }
    // 新建資料夾（寫入 → 需成員 token）：在當前瀏覽的子目錄 sub 下建一層 name。
    const mRoomMkdir = path.match(/^\/v1\/rooms\/([^/]+)\/mkdir$/);
    if (req.method === 'POST' && mRoomMkdir) {
      const room = rooms.get(mRoomMkdir[1]); if (!room) return json(res, 404, { error: 'room not found' });
      const authMk = roomAuth(req, room, 'member'); if (!authMk.ok) return json(res, 401, { error: '需要成員 token' });
      if (room.readonly && !authMk.master) return json(res, 403, { error: '此會議室為唯讀，僅主持人可建資料夾' });
      const body = await readBody(req);
      const rel = joinUploadRel(body.sub, body.name);
      if (!rel) return json(res, 400, { error: '資料夾名稱不合法' });
      const full = resolveArtifact(workspaceDir(baseDir, room.workspace, local), rel);
      if (!full) return json(res, 400, { error: 'path 不合法' });
      try { mkdirSync(full, { recursive: true }); } catch (e) { return json(res, 400, { error: e.message }); }
      log({ room: mRoomMkdir[1], action: 'mkdir', path: rel });
      return json(res, 200, { ok: true, sub: rel });
    }
    // 上傳檔案（寫入 → 需成員 token）：原始 bytes 進 body，目標由 query 決定（sub=當前資料夾、name=檔名）
    // → 使用者先在檔案區導覽到某資料夾，再上傳即落在該資料夾。防穿越 + 大小上限。
    const mRoomUpload = path.match(/^\/v1\/rooms\/([^/]+)\/upload$/);
    if (req.method === 'POST' && mRoomUpload) {
      const room = rooms.get(mRoomUpload[1]); if (!room) return json(res, 404, { error: 'room not found' });
      const authUp = roomAuth(req, room, 'member'); if (!authUp.ok) return json(res, 401, { error: '需要成員 token' });
      if (room.readonly && !authUp.master) return json(res, 403, { error: '此會議室為唯讀，僅主持人可上傳' });
      const rel = joinUploadRel(url.searchParams.get('sub'), url.searchParams.get('name'));
      if (!rel) return json(res, 400, { error: '檔名不合法' });
      const full = resolveArtifact(workspaceDir(baseDir, room.workspace, local), rel);
      if (!full) return json(res, 400, { error: 'path 不合法' });
      const r = await readRaw(req);
      if (r.over) return json(res, 413, { error: `檔案過大（上限 ${Math.round(MAX_UPLOAD / 1048576)}MB）` });
      if (!r.buffer || !r.buffer.length) return json(res, 400, { error: '空檔案' });
      try { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, r.buffer); } catch (e) { return json(res, 400, { error: e.message }); }
      log({ room: mRoomUpload[1], action: 'upload', path: rel, size: r.buffer.length });
      return json(res, 200, { ok: true, name: basename(full), size: r.buffer.length, sub: rel });
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
        log({ pack: body.pack || 'general', session: r.sessionId, mode: body.mode || 'turn', stop: r.stopReason, empty: !r.text || undefined, tokens: r.usage.input + r.usage.output, rounds: r.rounds, ms: Date.now() - t0 });
        if (streaming) { sse({ type: 'done', ...r }); res.end(); } else json(res, 200, r);
      } catch (e) {
        if (clientGone) return;
        log({ pack: body.pack, error: e.message });
        if (streaming) { sse({ type: 'error', error: e.message }); res.end(); } else json(res, /^未知 pack|^未知 model|工作目錄/.test(e.message || '') ? 400 : 500, { error: e.message });
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

// 從設定引導頁送來的表單組出 providers.json 內容（單 provider + 單 model，足以啟動；之後可自行擴充檔案）。
export function buildSetupConfig(body = {}) {
  const provider = String(body.provider || '').trim();
  const baseUrl = String(body.baseUrl || '').trim();
  const apiKey = String(body.apiKey || '').trim();
  const modelId = String(body.modelId || '').trim();
  if (!provider || !baseUrl || !apiKey || !modelId) throw new Error('provider / baseUrl / apiKey / modelId 皆為必填');
  const model = { id: modelId, name: String(body.modelName || '').trim() || modelId };
  if (Number(body.contextWindow) > 0) model.contextWindow = Number(body.contextWindow);
  if (Number(body.maxTokens) > 0) model.maxTokens = Number(body.maxTokens);
  return {
    defaultModel: modelId,
    providers: { [provider]: { api: String(body.api || 'openai-completions'), baseUrl, apiKey, models: [model] } },
  };
}

// 把表單組出的設定「合併」進既有 providers.json（新增/更新一個 provider 或其 model），不覆蓋其他 provider。
// base 為現有設定（可 null=尚無檔案時等同新建）。defaultModel 保留既有（新增 provider 不該偷改全域預設）。
export function mergeSetupConfig(base, body) {
  const add = buildSetupConfig(body);
  if (!base || !base.providers) return add;
  const [p, pcfg] = Object.entries(add.providers)[0];
  const providers = { ...base.providers };
  if (providers[p]) {
    const models = [...(providers[p].models || [])];
    for (const m of pcfg.models) { const i = models.findIndex((x) => x.id === m.id); if (i >= 0) models[i] = m; else models.push(m); }
    providers[p] = { ...providers[p], api: pcfg.api, baseUrl: pcfg.baseUrl, apiKey: pcfg.apiKey, models };
  } else providers[p] = pcfg;
  // 預設 model：保留既有；除非明確要求（makeDefault）或既有沒有 → 用新加的這顆。
  const defaultModel = (body.makeDefault || !base.defaultModel) ? add.defaultModel : base.defaultModel;
  return { ...base, defaultModel, providers };
}

// 設定引導頁：完全自包含（內聯樣式、不 link 任何外部 css/js）→ 即使 web/ 資源缺失也能顯示。
const SETUP_HTML = `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>xitto · 初始設定</title>
<style>
:root{--bg:#0f1115;--card:#191c23;--inset:#12141a;--line:#2a2e37;--fg:#e6e8ee;--dim:#9aa0ad;--accent:#5b63e6;--btnfg:#fff;--ok:#3fb950;--err:#e5484d}
@media (prefers-color-scheme: light){:root{--bg:#f5f6f8;--card:#fff;--inset:#f0f1f4;--line:#d9dce2;--fg:#1a1d24;--dim:#6b7280;--btnfg:#fff}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;width:min(520px,96vw);padding:26px;max-height:94vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.brand svg{width:30px;height:30px}.brand h1{font-size:20px;margin:0}
.sub{color:var(--dim);font-size:14px;margin:0 0 18px}
label{display:block;font-size:13px;color:var(--dim);margin:14px 0 5px}
input,select{width:100%;background:var(--inset);color:var(--fg);border:1px solid var(--line);border-radius:9px;padding:9px 11px;font:inherit}
input:focus,select:focus{outline:none;border-color:var(--accent)}
.grid2{display:flex;gap:10px}.grid2>div{flex:1}
details{border:1px solid var(--line);border-radius:9px;padding:0 12px;margin-top:14px}
summary{cursor:pointer;padding:9px 0;font-size:13px;color:var(--dim)}
button{background:var(--accent);color:var(--btnfg);border:0;border-radius:9px;padding:11px 16px;font:inherit;font-weight:600;cursor:pointer;width:100%;margin-top:18px}
button:disabled{opacity:.6;cursor:default}
.msg{margin-top:14px;font-size:13px;padding:9px 12px;border-radius:9px;display:none}
.msg.err{display:block;color:var(--err);background:color-mix(in srgb,var(--err) 12%,transparent);border:1px solid color-mix(in srgb,var(--err) 35%,var(--line))}
.msg.ok{display:block;color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent);border:1px solid color-mix(in srgb,var(--ok) 35%,var(--line))}
.hint{color:var(--dim);font-size:12px;margin-top:4px}
code{background:var(--inset);padding:1px 5px;border-radius:5px;font-size:.9em}
#existing{margin:0 0 6px}
.exist-h{font-size:13px;color:var(--dim);margin:2px 0 8px}
.exist-p{border:1px solid var(--line);border-radius:9px;padding:9px 12px;margin-bottom:8px;background:var(--inset)}
.exist-p b{font-size:13px}
.exist-m{font-size:12px;color:var(--dim);margin-top:3px}
.exist-m .def{color:var(--accent);font-weight:600}
</style></head><body>
<div class="card">
  <div class="brand"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#5b63e6"/><g fill="#fff"><path d="M11 21l8-8 1.6 1.6-8 8z" opacity=".95"/><path d="M20 9l.7 1.8L22.5 11.5l-1.8.7L20 14l-.7-1.8L17.5 11.5l1.8-.7z"/></g></svg><h1>初始設定</h1></div>
  <p class="sub">尚未偵測到 provider 設定（<code>providers.json</code>）。填入要用的模型服務，儲存後服務會自動啟動——不需要重進容器。</p>
  <div id="existing"></div>
  <label>快速套用（選一個服務會自動帶入網址，仍可修改）</label>
  <select id="preset">
    <option value="custom">自訂 / 其他 OpenAI 相容服務</option>
    <option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option>
    <option value="minimax">MiniMax</option><option value="openrouter">OpenRouter</option>
    <option value="anthropic">Anthropic (Claude)</option>
  </select>
  <div class="grid2">
    <div><label>Provider 名稱</label><input id="provider" placeholder="openai" autocomplete="off"></div>
    <div><label>API 介面</label><select id="api"><option>openai-completions</option><option>openai-responses</option><option>anthropic-messages</option></select></div>
  </div>
  <label>Base URL</label><input id="baseUrl" placeholder="https://api.openai.com/v1" autocomplete="off">
  <label>API Key</label><input id="apiKey" type="password" placeholder="sk-…" autocomplete="off">
  <div class="hint">也可填 <code>&#36;{ENV_VAR}</code> 讓它從環境變數讀取（例如 <code>&#36;{OPENAI_API_KEY}</code>）。</div>
  <div class="grid2">
    <div><label>Model ID</label><input id="modelId" placeholder="gpt-4o" autocomplete="off"></div>
    <div><label>顯示名稱（可留白）</label><input id="modelName" placeholder="同 Model ID" autocomplete="off"></div>
  </div>
  <details><summary>進階（可留白用預設）</summary>
    <div class="grid2" style="margin-bottom:12px"><div><label>Context Window</label><input id="contextWindow" type="number" placeholder="128000"></div><div><label>Max Tokens</label><input id="maxTokens" type="number" placeholder="4096"></div></div>
  </details>
  <label id="defWrap" style="display:none;align-items:center;gap:8px;margin-top:14px;cursor:pointer;color:var(--fg)">
    <input type="checkbox" id="makeDefault" style="width:auto;margin:0"> 設為預設模型（新會議 / 未指定時用它）
  </label>
  <div class="msg" id="msg"></div>
  <button id="save" type="button">儲存並啟動</button>
</div>
<script>
var $=function(s){return document.querySelector(s)};
var PRESETS={custom:{provider:"",api:"openai-completions",baseUrl:"",model:""},openai:{provider:"openai",api:"openai-completions",baseUrl:"https://api.openai.com/v1",model:"gpt-4o"},deepseek:{provider:"deepseek",api:"openai-completions",baseUrl:"https://api.deepseek.com",model:"deepseek-chat"},minimax:{provider:"minimax",api:"openai-completions",baseUrl:"https://api.minimaxi.com/v1",model:"MiniMax-M2"},openrouter:{provider:"openrouter",api:"openai-completions",baseUrl:"https://openrouter.ai/api/v1",model:""},anthropic:{provider:"anthropic",api:"anthropic-messages",baseUrl:"https://api.anthropic.com",model:"claude-sonnet-4"}};
function applyPreset(){var p=PRESETS[$("#preset").value]||PRESETS.custom;$("#provider").value=p.provider;$("#api").value=p.api;$("#baseUrl").value=p.baseUrl;$("#modelId").value=p.model}
$("#preset").onchange=applyPreset;applyPreset();
// token 從 URL 帶（/settings?token= 進來時需要；首次引導頁無 token 也無妨）→ 附到 /v1/setup 請求。
var TK=new URLSearchParams(location.search).get("token");
var AUTH=TK?{"content-type":"application/json",authorization:"Bearer "+TK}:{"content-type":"application/json"};
// EXISTING：/settings 進來時由後端注入現有設定（[{provider,api,models:[{id,name,default}]}]）；首次引導頁為 null。
var EXISTING=/*EXISTING*/null;
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
function esch(t,k){var e=$("#msg");e.textContent=t;e.className="msg "+k}
var showMsg=esch;
if(EXISTING){                              // 設定模式：顯示已配置的 provider/model 清單 + 允許設預設
  $("#defWrap").style.display="flex";
  var n=EXISTING.reduce(function(a,p){return a+p.models.length},0);
  var html='<div class="exist-h">目前已配置 '+EXISTING.length+' 個 provider · '+n+' 個模型（下方表單可新增或更新一個；不會覆蓋其他）：</div>';
  EXISTING.forEach(function(p){
    html+='<div class="exist-p"><b>'+esc(p.provider)+'</b> <span class="exist-m">'+esc(p.api||"")+'</span><div class="exist-m">'+
      p.models.map(function(m){return (m.default?'<span class="def">★ ':'')+esc(m.name||m.id)+(m.name&&m.name!==m.id?' ('+esc(m.id)+')':'')+(m.default?'（預設）</span>':'')}).join(' · ')+'</div></div>';
  });
  $("#existing").innerHTML=html;
  $("#save").textContent="新增 / 更新模型";
}
$("#save").onclick=async function(){
  var body={provider:$("#provider").value.trim(),api:$("#api").value,baseUrl:$("#baseUrl").value.trim(),apiKey:$("#apiKey").value.trim(),modelId:$("#modelId").value.trim(),modelName:$("#modelName").value.trim(),contextWindow:Number($("#contextWindow").value)||undefined,maxTokens:Number($("#maxTokens").value)||undefined,makeDefault:$("#makeDefault").checked||undefined};
  if(!body.provider||!body.baseUrl||!body.apiKey||!body.modelId)return showMsg("Provider 名稱、Base URL、API Key、Model ID 皆為必填。","err");
  $("#save").disabled=true;showMsg("儲存中…","ok");
  var r;try{r=await fetch("/v1/setup",{method:"POST",headers:AUTH,body:JSON.stringify(body)}).then(function(x){return x.json()})}catch(e){r={error:"無法連線到伺服器"}}
  if(!r||r.error){$("#save").disabled=false;return showMsg((r&&r.error)||"儲存失敗","err")}
  showMsg(EXISTING?"已儲存，服務重載中…（稍候本頁自動刷新，可繼續新增）":"設定完成，服務啟動中…（稍候會自動進入）","ok");
  var tries=0;
  var poll=async function(){tries++;try{var h=await fetch("/health",{cache:"no-store"}).then(function(x){return x.json()});if(h&&h.mode!=="setup"){location.href=EXISTING?location.pathname+location.search:"/";return}}catch(e){}if(tries>40)return showMsg("服務已重載，請手動重新整理頁面。","ok");setTimeout(poll,800)};
  setTimeout(poll,1000);
};
</script>
</body></html>`;

// 設定引導伺服器：尚無有效 providers.json 時啟動，提供網頁讓使用者填 provider/model，
// 存檔後就地熱重啟成正式服務（同 port，不需重進容器）。只服務設定頁 + /v1/setup + /health + favicon。
export function startSetupServer(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 8787);
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
  let server;
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); const path = url.pathname;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, mode: 'setup' });
    if (req.method === 'GET' && (path === '/favicon.ico' || path === '/favicon.svg')) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#5b63e6"/><g fill="#fff"><path d="M11 21l8-8 1.6 1.6-8 8z" opacity=".95"/><path d="M20 9l.7 1.8L22.5 11.5l-1.8.7L20 14l-.7-1.8L17.5 11.5l1.8-.7z"/></g></svg>';
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' }); return res.end(svg);
    }
    if (req.method === 'POST' && path === '/v1/setup') {
      const body = await readBody(req);
      let cfg; try { cfg = buildSetupConfig(body); buildModel(cfg, cfg.defaultModel); } catch (e) { return json(res, 400, { error: e.message }); }
      const cfgPath = providersConfigPath(opts.configPath);
      try { mkdirSync(dirname(cfgPath), { recursive: true }); writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); }
      catch (e) { return json(res, 500, { error: '寫入設定失敗：' + e.message }); }
      console.log(`✅ 已寫入設定：${cfgPath} → 熱重啟為正式服務`);
      json(res, 200, { ok: true, path: cfgPath });
      // 回應送達後再切換：關掉設定 server，用同 opts 起正式 server（此時檔案已存在，loadModel 會成功）。
      setTimeout(() => { try { server.close(); } catch { /* 略 */ } startServer(opts); }, 300);
      return;
    }
    // 其餘一律回設定頁（內聯 HTML + 內聯樣式，不依賴任何外部檔案 → 殘缺/剛部署的環境也能顯示）
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SETUP_HTML);
  });
  server.listen(port, () => {
    console.log(`⚙️  尚未設定 provider → 開啟設定引導頁：http://localhost:${port}/`);
    console.log('   在瀏覽器填入服務網址 / API Key / model 後按「儲存並啟動」，服務會自動接手（無需重進容器）。');
  });
  return server;
}

// opts 優先於環境變數；未給則沿用 env / 預設（向後相容原本的 env-only 啟動）。
// 可傳入已載入的 { model, getApiKey }（CLI serve 用），否則由 loadModel 依 providers.json 載入。
export function startServer(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 8787);
  const token = opts.token ?? process.env.XITTO_SERVER_TOKEN ?? 'dev-token';
  const sandbox = opts.sandbox ?? (process.env.XITTO_SERVER_SANDBOX !== 'off');
  const concurrency = Number(opts.concurrency ?? process.env.XITTO_SERVER_CONCURRENCY ?? 2);
  const local = opts.local ?? (process.env.XITTO_SERVER_LOCAL === '1' || process.env.XITTO_SERVER_LOCAL === 'true');
  // 所有落地狀態（rooms/sessions/tasks/ws）皆掛在 baseDir 下 → 容器部署時指到掛載卷（PVC）才不會重啟即丟。
  const baseDir = opts.baseDir ?? process.env.XITTO_SERVER_DIR ?? '.xitto-server';
  let model, getApiKey, resolveModel, models;
  try { ({ model, getApiKey, resolveModel, models } = (opts.model && opts.getApiKey) ? opts : loadModel(opts.modelId ?? process.env.XITTO_MODEL)); }
  catch (e) {
    // 缺設定 / 找不到 model / 設定壞掉 → 不崩潰，改開設定引導頁讓使用者就地填寫。
    console.warn(`⚠️  無法載入 model 設定：${e.message}`);
    return startSetupServer({ ...opts, port });
  }
  // 對外網址：明確設定（域名/反代）優先；否則取第一個區網 IP，讓同網段其他人與邀請連結都能連入。
  const ips = lanIPs();
  const publicOrigin = String(opts.publicUrl ?? process.env.XITTO_PUBLIC_URL ?? (ips[0] ? `http://${ips[0]}:${port}` : '')).replace(/\/$/, '');
  let server;
  // 熱重載：/v1/setup 存檔後關掉現有 server、用同 opts 重起（載入新設定），同 port 不需重進容器。
  const onReconfigure = () => { try { server.close(); } catch { /* 略 */ } startServer(opts); };
  server = createServerApp({ model, getApiKey, resolveModel, models, token, baseDir, sandbox, concurrency, local, publicOrigin, configPath: opts.configPath, onReconfigure });
  server.listen(port, () => {
    console.log(`🪄 許願台：http://localhost:${port}/  （本機瀏覽器打開即用）`);
    console.log(`👥 會議室：http://localhost:${port}/room  （多人 + AI 針對專案對談；點名 @ai 才回覆）`);
    if (ips.length) {
      console.log('🌐 區網位址（同網段其他人可用這些連入 / 邀請連結也會用第一個）：');
      for (const ip of ips) console.log(`   http://${ip}:${port}/room`);
    } else {
      console.log('🌐 未偵測到區網 IP（僅 localhost 可連）。要讓別人連入請設 XITTO_PUBLIC_URL=http://<你的位址>:port');
    }
    if (publicOrigin) console.log(`   邀請連結對外網址：${publicOrigin}`);
    console.log(`xitto-kernel server · model ${model.id} · 沙箱 ${sandbox ? '開' : '關'} · 背景並發 ${concurrency}${local ? ' · 本地模式(顯示檔案位置)' : ''}`);
    console.log(`token: ${token === 'dev-token' ? 'dev-token（請設 XITTO_SERVER_TOKEN）' : '(已設定)'}`);
    console.log(`狀態目錄（rooms/sessions/tasks/ws）：${resolve(baseDir)}${process.env.XITTO_SERVER_DIR ? '' : '（相對路徑；容器部署請設 XITTO_SERVER_DIR 指到掛載卷）'}`);
    console.log('API：POST /v1/run · /v1/stream · /v1/tasks · /v1/tasks/:id/{answer,steer,cancel}｜GET /v1/tasks[/:id[/events|/file]] · /health');
    console.log('會議室：POST /v1/rooms · /v1/rooms/:id/{join,leave,say,invite,mkdir,upload,model} · DELETE /v1/rooms/:id｜GET /v1/rooms[/:id[/events|/files|/file]] · /v1/models');
  });
  return server;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) startServer();
