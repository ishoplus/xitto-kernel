// Server app（PoC）— 把 kernel 包成 HTTP 服務（零依賴 node:http）。
// 證明 kernel 能脫離 CLI 跑成服務：bearer token 認證、per-session 隔離工作目錄、沙箱、結構化日誌、
// JSON 或 SSE 串流，以及「背景任務 + 完成通知（webhook）」—— 派任務出去、做完回呼，不用一直盯著。
// 這是「另一個 app 消費同一組 kernel 事件」—— 不動 kernel 核心。
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { createKernel } from '../kernel/index.js';
import { cacheRetentionFor } from '../kernel/provider.js';
import { createMemory } from '../kernel/memory.js';
import { createEpisodes } from '../kernel/episodes.js';
import { createSkills } from '../kernel/skills.js';
import { createPlaybook } from '../kernel/playbook.js';
import { fileAllowStore } from '../kernel/security/allow-store.js';
import { loadModel, buildModel, providersConfigPath, loadProvidersConfig } from './providers.js';
import { oauth2Auth, parseTtl } from './auth-oauth2.js';
import { attachUpgrade } from './ws.js';
import { isMutating } from '../kernel/tool-registry.js';
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
 * 專案會議室（多人 + LLM）。純記憶體 + 可選持久化，與 HTTP 無關、可單測。
 * 一間房 = 共享 workspace（五層經驗累積）+ 共享訊息流（replay/紀要/上下文）+ 成員 + 每人一條 AI lane。
 * 每人一條 lane：獨立 session（私有 history）、並發跑（別人的複雜問題不卡你）、各自可中斷；
 * 但共享會議全部上下文（每輪注入「你不在時房裡發生的增量」）。人類發言即時廣播；只有 @ai 才觸發回覆。
 * @param {Object} o
 * @param {(args:{room:object,input:string,emit:(ev:object)=>void,onAgent:(a:any)=>void,readOnly:boolean,sessionId?:string})=>Promise<any>} o.runAiTurn  跑一輪 AI（用傳入的 lane sessionId 續接；回傳 { sessionId, text, ... }）
 * @param {string} [o.persistDir]     每間房落地一個 json（重啟後房間與訊息還在；成員與 lane 為即時態不存）
 * @param {number} [o.maxMessages]    每房保留最近幾則訊息（replay 用，預設 300）
 * @param {number} [o.maxPending]     每條 lane 最多累積幾則待處理（預設 50）
 * @param {number} [o.maxConcurrency] 一房最多幾條 lane 同時跑 AI（預設 3；超出排隊）
 */
// 會議紀要 goal：把整段對話 transcript 整理成三節（決策/待辦/摘要）並用 gen_doc 產出檔案。只依對話、不編造。
// filename 由呼叫端帶入（帶時間戳）→ 每次生成獨立成檔、不覆蓋既有紀要（避免資料丟失）。
export const minutesGoal = (transcript, filename = '會議紀要.pdf') => [
  `把以下「會議對話」整理成一份專業會議紀要，用 gen_doc 產出檔案 ${filename}（缺工具會自動退回 HTML，沒關係）。務必使用這個確切檔名，不要改名、不要覆蓋其他既有檔案。`,
  '內容分三節，用 markdown 標題：',
  '## 決策（會議達成的結論；沒有就寫「（無）」）',
  '## 待辦（可執行的行動項，盡量標出負責人與期限；沒有就寫「（無）」）',
  '## 摘要（討論重點與脈絡）',
  '只根據對話內容，不要編造未提及的事；發言人以 [名字] 標示。',
  '',
  '會議對話：',
  String(transcript || '').slice(0, 24000),
].join('\n');

// 上傳文件自動簡報 prompt：AI 主動用一兩句說明文件在講什麼，再提議 1–3 件可據此做的具體事。
// 內容已由 HTTP 層抽好（doc-extract／純文字）傳入，只讀不改；語氣像會議裡自然搭話。
export const briefPrompt = (name, text) => [
  `有成員剛上傳了檔案《${name}》到會議工作區。以下是它的內容（節選）。`,
  '請先用一到兩句話說明這份檔案在講什麼，再主動提議接下來可以據此做的 1–3 件具體事',
  '（例如「要我整理成摘要／翻譯／據此起草…嗎？」）。語氣像在會議裡自然搭話：簡潔、不客套、不要逐段複述。',
  '',
  '---',
  String(text || '').slice(0, 12000),
].join('\n');

// 決策／待辦的廉價啟發式分類（零 token：不呼叫 LLM，只用正則）。
// 保守：寧可漏抓也不亂抓（誤判會污染記錄）。同時命中→有指派/期限者算「待辦」，否則「決策」。
// 回 'action' | 'decision' | null。
export function classifyLedger(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  const action =
    /(^|[\s，,、])(我來|我負責|我來負責|我處理|我搞定|我跟進|你來|你負責|請你|麻煩你?|幫我|指派|分派|認領)/.test(s) ||
    /(待辦|to-?do|action item|行動項|記得要|別忘了|要記得)/i.test(s) ||
    /(deadline|截止|期限|限期|交期)/i.test(s) ||
    /((這|本|下|上)?(週|周|禮拜|星期)[一二三四五六日天]|今天|明天|後天|下週|下周|月底|週末|周末|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}[日號])[^。！!？?]{0,6}(前|之前|截止|完成|交)/.test(s) ||
    /(前|之前)\s*(完成|交付?|給我|做完|搞定|提交)/.test(s);
  const decision =
    /(就這麼定|就這樣定|就這麼辦|就這樣辦|定案|拍板|敲定|一致(同意|通過)|結論(是|為|就是)|最終決定|決議|我們(就)?(用|採用|選用|選擇)|那就(用|採用|選))/.test(s) ||
    /\b(decide[ds]?|decision|let'?s\s+go\s+with|finaliz)/i.test(s);
  if (action) return 'action';
  if (decision) return 'decision';
  return null;
}

// 把一條決策／待辦即時追加進工作區的「會議記錄.md」（活的、討論中就留痕；散會另出正式紀要）。
// 新項插在對應段落標題正下方（最新在上）；輕量去重（同段已有相同原句就跳過）。純同步檔操作、失敗靜默。
export function appendLedger(dir, { kind, name, text }) {
  const file = join(dir, '會議記錄.md');
  const header = kind === 'action' ? '## 待辦' : '## 決策';
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = `- [${name}] ${clean}　（${ts}）`;
  let body = '';
  try { body = existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { body = ''; }
  if (!body.trim()) body = '# 會議記錄（自動彙整，討論中即時留痕；散會會另出正式紀要）\n\n## 決策\n\n## 待辦\n';
  const lines = body.split('\n');
  let idx = lines.findIndex((l) => l.trim() === header);
  if (idx === -1) { lines.push('', header); idx = lines.length - 1; }
  // 去重：同一段落已有一模一樣的原句 → 不重複記
  const secEnd = lines.findIndex((l, i) => i > idx && /^##\s/.test(l));
  const sec = lines.slice(idx + 1, secEnd === -1 ? undefined : secEnd);
  if (sec.some((l) => l.includes(clean))) return false;
  lines.splice(idx + 1, 0, line);
  try { mkdirSync(dir, { recursive: true }); writeFileSync(file, lines.join('\n')); return true; } catch { return false; }
}

export function createRoomStore({ runAiTurn, runMinutes, persistDir, maxMessages = 300, maxPending = 50, maxConcurrency = 3, autoMinutes = true, onLedger } = {}) {
  const rooms = new Map();  // id -> room
  const subs = new Map();   // id -> Set<(ev)=>void>

  const snapshot = (r) => ({ id: r.id, name: r.name || '', workspace: r.workspace, pack: r.pack, model: r.model || null, readonly: !!r.readonly, sessionId: r.sessionId, inviteToken: r.inviteToken, messages: r.messages, createdAt: r.createdAt });
  const persist = (r) => { if (!persistDir) return; try { mkdirSync(persistDir, { recursive: true }); writeFileSync(join(persistDir, r.id + '.json'), JSON.stringify(snapshot(r))); } catch { /* 略 */ } };
  // 完整逐字稿（append-only）：replay buffer（r.messages）為省記憶體硬砍最近 maxMessages 則，
  // 但紀要需要「整場」內容。每則訊息在此另 append 進 <persistDir>/<id>.transcript.jsonl（不進記憶體、不砍）。
  const transcriptPath = (r) => join(persistDir, r.id + '.transcript.jsonl');
  const appendTranscript = (r, m) => { if (!persistDir) return; try { mkdirSync(persistDir, { recursive: true }); appendFileSync(transcriptPath(r), JSON.stringify({ ts: m.ts, kind: m.kind, name: m.name || m.kind, text: m.text }) + '\n'); } catch { /* 略 */ } };
  // 取整場逐字稿：優先讀 append-only 檔（含被 replay buffer 砍掉的前段）；無持久化/無檔則退回 r.messages。
  const fullTranscript = (r) => {
    if (persistDir) { try { const raw = readFileSync(transcriptPath(r), 'utf8'); const lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); if (lines.length) return lines; } catch { /* 無檔 → 退回 */ } }
    return r.messages;
  };
  if (persistDir && existsSync(persistDir)) {
    for (const f of readdirSync(persistDir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const s = JSON.parse(readFileSync(join(persistDir, f), 'utf8'));
        rooms.set(s.id, { ...s, messages: s.messages || [], members: new Map(), online: new Map(), lanes: new Map() });
      } catch { /* 壞檔略 */ }
    }
  }

  const memberNames = (r) => [...r.members.values()].map((m) => m.name);
  // 在線名單（presence）：有活躍 SSE 連線的成員（r.online: memberId→連線數）；與「已加入名冊」區分（關分頁不算離開）。
  const onlineNames = (r) => [...r.members.entries()].filter(([mid]) => (r.online?.get(mid) || 0) > 0).map(([, m]) => m.name);

  // ── 每人一條 AI lane（並發、私有 session、各自可中斷）──
  // 一條 lane = 某成員跟 AI 的獨立回合線：自己的 pending 佇列、thinking 狀態、agentRef（供中止）、
  // sessionId（私有 history 連續性）、lastSeenTs（已看到共享 transcript 到哪，供「共享上下文增量」注入）。
  // 不同成員的 lane 並行跑 → 別人的複雜問題不會卡住你的快問；同一成員同 lane 串行（回合制不重疊）。
  const laneOf = (r, mid) => {
    let L = r.lanes.get(mid);
    if (!L) { L = { sessionId: null, pending: [], status: 'idle', agentRef: null, _stopped: false, lastSeenTs: 0 }; r.lanes.set(mid, L); }
    return L;
  };
  const activeCount = (r) => [...r.lanes.values()].filter((L) => L.status === 'thinking').length;
  const roomStatus = (r) => (activeCount(r) > 0 ? 'thinking' : 'idle'); // 房級聚合狀態（任一 lane 忙 = 忙）：相容既有前端單一狀態列/停止鈕

  const view = (r) => ({ roomId: r.id, name: r.name || '', workspace: r.workspace, pack: r.pack, model: r.model || null, readonly: !!r.readonly, sessionId: r.sessionId || null, status: roomStatus(r), members: memberNames(r), online: onlineNames(r), memberCount: r.members.size, messageCount: r.messages.length, createdAt: r.createdAt });

  const fanout = (r, ev) => { const s = subs.get(r.id); if (s) for (const fn of s) { try { fn(ev); } catch { /* 訂閱端錯不影響房間 */ } } };
  // 記錄一則訊息（人類/AI/系統）進 replay buffer 並廣播。
  const push = (r, msg) => {
    const m = { id: newId('m'), ts: new Date().toISOString(), ...msg };
    r.messages.push(m); if (r.messages.length > maxMessages) r.messages.shift();
    appendTranscript(r, m); // 進完整逐字稿（不受 replay buffer 上限影響）→ 長會紀要不漏前段
    fanout(r, { type: 'say', message: m });
    return m;
  };

  // 一則訊息餵給 LLM 的呈現：AI 對某人的回覆標「[AI→名字]」（避免某條 lane 誤以為那是對它說的）、系統標「[系統]」、其餘「[名字]」。
  const fmtForLlm = (m) => (m.kind === 'ai' ? `[AI→${m.to || '某人'}] ${m.text}` : m.kind === 'system' ? `[系統] ${m.text}` : `[${m.name}] ${m.text}`);

  // 會議室情境提示（L1 群聊感知）：讓 AI 知道自己在多人房、發言以「[名字]」標明發話人、要分辨誰在問並點名回覆。
  // 每輪注入（成員名單會變動、弱模型跨輪會遺忘），保持精簡以免 history 膨脹；只有一位成員時語氣不強調「多人」。
  const roomContext = (r, { readOnly } = {}) => {
    const names = memberNames(r);
    const who = names.length ? names.join('、') : '（暫無其他成員）';
    const multi = names.length > 1;
    return `〔會議室情境〕你在一個多人協作房間，當前成員：${who}。發言以「[名字]」標明發話人，AI 過往回覆標「[AI→對象]」。`
      + (multi
        ? '請分辨各則分別出自誰；回覆時點名對方（例如「@小明 …」）。'
        : '回覆時可點名發話人。')
      + (readOnly ? '（注意：本輪的提問者為唯讀訪客，若被要求修改/刪除共享檔案，請禮貌說明你在此輪無法改動，只能提供建議或說明做法。）' : '')
      + '\n\n';
  };

  // 組一輪的 input：房間情境 + 「你不在時房裡發生的共享增量」（別人發言 / AI 回別人 / 系統，按歸屬過濾）+ 本次要你回應的發言。
  // 共享增量讓每條獨立 lane 都掌握「整場會議」上下文；自己過去的回合已在自己的 session history，不重複注入。
  const buildInput = (r, L, mid, batch, readOnly, seen) => {
    const delta = r.messages.filter((m) => (Date.parse(m.ts) || 0) > seen && m.by !== mid && m.for !== mid);
    const shared = delta.length
      ? '〔會議室其他動態（你剛才在忙時發生的）〕\n' + delta.slice(-40).map(fmtForLlm).join('\n').slice(-4000) + '\n\n'
      : '';
    return roomContext(r, { readOnly }) + shared + '〔請你回應以下發言〕\n' + batch.map((m) => `[${m.name}] ${m.text}`).join('\n');
  };

  // lane 的顯示標籤：成員 lane → 該成員名；保留 lane → 人話（供前端 per-user 狀態/串流泡泡標示）。
  const laneLabel = (r, mid) => (mid === '__minutes__' ? '會議紀要' : mid === '__auto__' ? 'AI 簡報' : (r.members.get(mid)?.name || '某成員'));
  // 房級狀態廣播：帶聚合 status（相容現有 UI 單一狀態列/停止鈕）＋ by/byName/laneStatus（哪條 lane、誰、該 lane 現況）供前端做 per-user 呈現。
  const emitStatus = (r, mid) => { const L = r.lanes.get(mid); fanout(r, { type: 'status', status: roomStatus(r), by: mid, byName: laneLabel(r, mid), laneStatus: L ? L.status : 'idle' }); };

  // 有界並發排程：把「有召喚待處理、且目前 idle」的 lane 拉起來跑，直到達到房間並發上限。
  // 上限保護（maxConcurrency）：避免一房 N 人同時 @ai 就對 provider 併發 N 條 → 超出的排隊，等有 lane 結束再拉起。
  const schedule = (r) => {
    for (const [mid, L] of r.lanes) {
      if (activeCount(r) >= maxConcurrency) break;
      if (L.status === 'idle' && L.pending.some((m) => m.mention)) runLane(r, mid);
    }
  };

  // 跑某成員的一輪 AI（該成員的 lane）：整理其待處理發言 + 共享增量餵給 LLM，用該 lane 的私有 session 續接。
  // 回合末：若同 lane 又有新 @ai 或別的 lane 在排隊 → schedule 續拉。被本人中止則該 lane 不自動續跑。
  async function runLane(r, mid) {
    const L = laneOf(r, mid);
    if (L.status === 'thinking') return;                 // 同 lane 串行：回合制不重疊
    if (activeCount(r) >= maxConcurrency) return;         // 併發已滿 → 交給後續 schedule 再拉
    const batch = L.pending.splice(0, L.pending.length);
    if (!batch.length) return;
    const seen = L.lastSeenTs;                            // 本輪之前「已看到共享 transcript 到哪」→ 用來抓增量
    L.status = 'thinking'; L.lastSeenTs = Date.now();     // 更新為此刻：回合中湧入的別人發言下輪才納入（不漏、不重覆）
    emitStatus(r, mid); persist(r);
    // L2 破壞性操作把關：召喚者含「不可寫」者（唯讀房非主持人）→ 此回合唯讀（剝除 mutating 工具）。
    const readOnly = batch.filter((m) => m.mention).some((m) => m.writeAllowed === false);
    const input = buildInput(r, L, mid, batch, readOnly, seen);
    const member = r.members.get(mid);
    let finalText = '';
    const emit = (ev) => { if (ev?.type === 'text') finalText += ev.delta || ''; fanout(r, { type: 'ai', by: mid, byName: member?.name || '', ev }); };
    const onAgent = (a) => { L.agentRef = a; };
    try {
      const res = await runAiTurn({ room: r, input, emit, onAgent, readOnly, sessionId: L.sessionId || undefined });
      if (res?.sessionId) { L.sessionId = res.sessionId; r.sessionId = res.sessionId; } // lane 私有 session；r.sessionId 鏡像最近一條（相容 view/snapshot/聯刪）
      const text = (res?.text ?? finalText) || '';
      if (!L._stopped) push(r, { kind: 'ai', name: 'AI', text, by: mid, for: mid, to: member?.name || '' }); // for=此 lane；別的 lane 增量會據此排除
    } catch (e) {
      if (!L._stopped) push(r, { kind: 'system', name: 'system', text: 'AI 回覆失敗：' + (e?.message || String(e)) });
    } finally {
      L.agentRef = null; L._stopped = false;
      L.status = 'idle'; emitStatus(r, mid); persist(r);
      schedule(r); // 拉起同 lane 續跑（新 @ai）或別條排隊中的 lane
    }
  }

  // 生成會議紀要：把「整場對話」（含未召喚 AI 的閒聊——那些沒進 session）整理成決策/待辦/摘要並產出檔案。
  // 走獨立 goal（fresh session、docgen pack）→ 不污染房間的共享對話 history；成品落房間 workspace，狀態轉 idle 時前端自動刷新檔案列表。
  const userMsgCount = (r) => r.messages.reduce((n, m) => n + (m.kind === 'user' ? 1 : 0), 0);
  async function generateMinutes(r) {
    r._minutesAt = userMsgCount(r); // 記下「已整理到第幾則人類發言」→ 供散會自動紀要去重（沒有新發言就不重跑）
    // 紀要用一條保留 lane（'__minutes__'）：參與房級聚合狀態（期間佔並發位、避免與寫入回合搶 workspace 檔），但不進成員名單、不被 schedule 拉起。
    const L = laneOf(r, '__minutes__');
    L.status = 'thinking'; emitStatus(r, '__minutes__'); persist(r);
    const transcript = fullTranscript(r).map((m) => `[${m.name || m.kind}] ${m.text}`).join('\n'); // 整場（含被 replay buffer 砍掉的前段）
    // 帶時間戳的檔名 → 每次生成獨立成檔，不覆蓋既有紀要（散會自動重跑也不會吃掉先前那份）。
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-'); // 20260706-153045
    const filename = `會議紀要-${stamp}.pdf`;
    const emit = (ev) => fanout(r, { type: 'ai', by: '__minutes__', ev });
    try {
      const res = await runMinutes({ room: r, transcript, filename, emit, onAgent: (a) => { L.agentRef = a; } });
      // 摘要按「行邊界」截斷（不切在行中間）→ 內含 markdown 表格不會被腰斬導致渲染失敗；超長才截並提示看檔案。
      const clip = (t) => {
        const s = String(t || '').trim(); if (s.length <= 1600) return s;
        const c = s.slice(0, 1600); const nl = c.lastIndexOf('\n');
        return (nl > 200 ? c.slice(0, nl) : c).trimEnd() + '\n\n…（完整內容見檔案）';
      };
      push(r, { kind: 'system', name: 'system', text: `📋 已整理會議紀要《${filename}》，請看「工作台」的檔案（可下載）。` + (res?.text ? '\n\n' + clip(res.text) : '') });
    } catch (e) {
      push(r, { kind: 'system', name: 'system', text: '生成會議紀要失敗：' + (e?.message || String(e)) });
    } finally {
      L.agentRef = null;
      L.status = 'idle'; emitStatus(r, '__minutes__'); persist(r);
    }
    return { ok: true };
  }

  // 主動簡報：有人上傳可讀文件 → AI 不等 @ai 就用一兩句說明並提議下一步。
  // 走保留 lane '__auto__'（獨立私有 session、參與房級忙碌狀態、不進成員名單、不被 schedule 拉起），
  // readOnly（只讀不改共享檔）。失敗靜默（自動行為不該用錯誤訊息打擾會議）。
  async function generateBrief(r, { name, text }) {
    const L = laneOf(r, '__auto__');
    if (L.status === 'thinking') return; // 已在簡報中 → 不疊（連續上傳多檔時，逐一交給回合末不處理，簡單起見只簡報當前忙完前的第一個）
    L.status = 'thinking'; emitStatus(r, '__auto__'); persist(r);
    let finalText = '';
    const emit = (ev) => { if (ev?.type === 'text') finalText += ev.delta || ''; fanout(r, { type: 'ai', by: '__auto__', ev }); };
    try {
      const res = await runAiTurn({ room: r, input: briefPrompt(name, text), emit, onAgent: (a) => { L.agentRef = a; }, readOnly: true, sessionId: L.sessionId || undefined });
      if (res?.sessionId) L.sessionId = res.sessionId; // __auto__ 私有 session：連續上傳有前後文
      const t = (res?.text ?? finalText) || '';
      if (t.trim()) push(r, { kind: 'ai', name: 'AI', text: t, by: '__auto__' });
    } catch { /* 靜默：簡報失敗不打擾會議 */ }
    finally {
      L.agentRef = null;
      L.status = 'idle'; emitStatus(r, '__auto__'); persist(r);
    }
  }

  // 散會自動紀要：最後一人離開房間 → 若自上次紀要後有夠多新發言，主動整理一份（不必誰記得按按鈕）。
  // 去重靠 r._minutesAt（generateMinutes 設）；門檻擋掉「進來沒聊幾句就走」的瑣碎房；忙碌中則略過。
  const maybeAutoMinutes = (r) => {
    if (!autoMinutes || !runMinutes) return;
    if (roomStatus(r) === 'thinking') return;              // 有回合/紀要在跑 → 不疊
    const n = userMsgCount(r);
    if (n < 3) return;                                     // 內容太少不值得整理
    if (n <= (r._minutesAt || 0)) return;                  // 自上次紀要後沒有新發言 → 不重跑
    generateMinutes(r);                                    // fire-and-forget（散會後無訂閱者也沒關係：紀要落 workspace 檔、系統訊息進 replay）
  };

  return {
    // 中止「自己那條 lane」進行中的 AI 回合（各停各的）：abort 該 lane 的 agent + 清該 lane pending + 廣播中止訊息。
    // 不傳 memberId（或該成員無進行中回合）→ 409，不影響別人的 lane。
    stop(id, memberId) {
      const r = rooms.get(id); if (!r) return { error: 'room not found', code: 404 };
      const L = memberId ? r.lanes.get(memberId) : null;
      if (!L || L.status !== 'thinking' || !L.agentRef) return { error: '你目前沒有進行中的 AI 回合', code: 409 };
      L._stopped = true; L.pending = [];
      try { L.agentRef.abort(); } catch { /* 略 */ }
      push(r, { kind: 'system', name: 'system', text: `⏹ ${r.members.get(memberId)?.name || '某成員'} 中止了自己的 AI 回覆` });
      return { ok: true };
    },
    // 生成會議紀要（成員可觸發）：同步校驗後 fire-and-forget，進度/結果經 SSE 廣播；回 { ok } 或 { error, code }。
    minutes(id) {
      const r = rooms.get(id); if (!r) return { error: 'room not found', code: 404 };
      if (!runMinutes) return { error: '此部署未啟用會議紀要', code: 501 };
      if (roomStatus(r) === 'thinking') return { error: 'AI 忙碌中，請稍候再試', code: 409 };
      if (!r.messages.length) return { error: '尚無對話可整理', code: 400 };
      generateMinutes(r); // 不 await：交給 SSE 廣播進度與結果
      return { ok: true };
    },
    // 上傳文件 → AI 主動簡報（HTTP 層抽好文字後呼叫；fire-and-forget，結果經 SSE 廣播）。
    // 需部署有接 runAiTurn；text 空或房不存在則靜默略過（自動行為不報錯）。
    autoBrief(id, { name = '檔案', text = '' } = {}) {
      const r = rooms.get(id); if (!r || !runAiTurn) return { skipped: true };
      if (!String(text).trim()) return { skipped: true };
      generateBrief(r, { name, text });
      return { ok: true };
    },
    create({ workspace = 'default', pack = 'general', model = null, name = '', readonly = false } = {}) {
      // inviteToken：房間專屬邀請碼（放進邀請連結，不再外洩 master token）。name：人類可讀會議名（可空，前端回退顯示 workspace）。
      // readonly：訪客唯讀（只能看檔案+聊天+@ai，不能上傳/建夾）；主持人（master）不受限。
      // model：此房 AI 回合用的 model（null=用伺服器預設）；與 pack 正交，可事後 setModel 切換。
      const nm = String(name || '').trim().slice(0, 60);
      const r = { id: newId('r'), name: nm, workspace, pack, model: model || null, readonly: !!readonly, sessionId: null, inviteToken: newToken(), members: new Map(), online: new Map(), messages: [], lanes: new Map(), createdAt: new Date().toISOString() };
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
      // 每條 lane 有自己的 session → 全部回傳供聯刪（避免孤兒 history）；sessionId 保留鏡像值供相容。
      const sessionIds = [...new Set([...r.lanes.values()].map((L) => L.sessionId).concat(r.sessionId).filter(Boolean))];
      fanout(r, { type: 'room_closed', roomId: id });
      const s = subs.get(id); if (s) { s.clear(); subs.delete(id); }
      rooms.delete(id);
      if (persistDir) { try { rmSync(join(persistDir, id + '.json'), { force: true }); rmSync(transcriptPath(r), { force: true }); } catch { /* 略 */ } }
      return { ok: true, sessionId: r.sessionId, sessionIds };
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
      if (r.members.size === 0) maybeAutoMinutes(r); // 最後一人離開＝散會 → 自動整理紀要
      return true;
    },
    // 發言：立刻廣播給全員 + 進「發話者自己那條 lane」的佇列；點名 @ai 才觸發（同 lane 忙則排隊、回合末續跑）。
    // 每人一條 lane → 別人的複雜問題不會卡住你的 @ai；由 schedule 依房間並發上限拉起。
    // writeAllowed：此發言者能否觸發寫入/破壞性操作（唯讀房的非主持人 = false）；帶進 pending 供 runLane 決定該回合是否唯讀（L2）。
    say(id, { memberId, text, writeAllowed = true, source }) {
      const r = rooms.get(id); if (!r) return { error: 'room not found', code: 404 };
      const m = r.members.get(memberId); if (!m) return { error: '請先加入房間', code: 403 };
      const msg = String(text ?? '').trim(); if (!msg) return { error: '發言不可為空', code: 400 };
      const mention = mentionsAi(msg);
      push(r, { kind: 'user', name: m.name, text: msg, by: memberId, ...(source ? { source } : {}) }); // by=發話者；source='voice' 標記語音轉錄
      // 決策/待辦即時沉澱：廉價正則命中（零 token）→ 交 app 層追加進「會議記錄.md」。失敗靜默，不影響發言。
      if (onLedger) { const tag = classifyLedger(msg); if (tag) { try { onLedger({ room: r, kind: tag, name: m.name, text: msg }); } catch { /* 靜默 */ } } }
      const L = laneOf(r, memberId);
      L.pending.push({ name: m.name, text: msg, mention, writeAllowed: writeAllowed !== false });
      while (L.pending.length > maxPending) L.pending.shift(); // 上限保護（保留最近，含召喚）
      persist(r);
      if (mention) schedule(r);
      return { ok: true, triggered: mention, status: roomStatus(r) };
    },
    subscribe(id, fn) { let s = subs.get(id); if (!s) { s = new Set(); subs.set(id, s); } s.add(fn); return () => s.delete(fn); },
    // 上線/下線（presence）：綁 SSE 連線生命週期。同一成員多分頁 → 計數；0↔1 轉換才廣播（省事件）。回退訂用函式。
    connect(id, memberId) {
      const r = rooms.get(id); if (!r || !memberId || !r.members.has(memberId)) return () => {};
      const n = (r.online.get(memberId) || 0) + 1; r.online.set(memberId, n);
      if (n === 1) fanout(r, { type: 'presence', online: onlineNames(r) });
      let done = false;
      return () => { // 斷線回收：計數歸零才廣播離線
        if (done) return; done = true;
        const c = (r.online.get(memberId) || 1) - 1;
        if (c <= 0) { r.online.delete(memberId); fanout(r, { type: 'presence', online: onlineNames(r) }); }
        else r.online.set(memberId, c);
      };
    },
    // 打字中（transient，不落地、不進 pending）：廣播給全員 → 前端顯示「X 正在輸入…」，逾時自動清。
    typing(id, memberId, on) {
      const r = rooms.get(id); if (!r) return { error: 'room not found', code: 404 };
      const m = r.members.get(memberId); if (!m) return { error: '請先加入房間', code: 403 };
      fanout(r, { type: 'typing', name: m.name, on: !!on });
      return { ok: true };
    },
    // 即時字幕（transient，不落地、不進 pending）：語音串流的 interim 文字廣播給全員 →
    // 前端顯示成該成員名下的浮動灰字；final=true 表定稿（前端清掉字幕，最終文字另由 say() 進紀錄/觸發 @ai）。
    caption(id, memberId, text, final) {
      const r = rooms.get(id); if (!r) return { error: 'room not found', code: 404 };
      const m = r.members.get(memberId); if (!m) return { error: '請先加入房間', code: 403 };
      fanout(r, { type: 'caption', name: m.name, by: memberId, text: String(text || ''), final: !!final });
      return { ok: true };
    },
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

// 認證 adapter（auth seam）：把「怎麼認人 / 授權」抽成可注入物件，讓部署者接自家 SSO 而不改原始碼（見 docs/10-sso-design.md）。
// adapter = { authed(req)->bool, roomAuth(req,room,need)->{ok,...}, principal?(req)->Principal|null, handle?(req,res)->Promise<bool> }
// defaultAuth：把現有 master-token / 邀請碼 / 成員 token 邏輯原樣封裝成預設 adapter → 未注入 adapter 時行為與過去逐位元組一致。
export function defaultAuth({ token } = {}) {
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
  // 預設無 SSO 身份（房間 join 走匿名 name）、無 /auth/* 路由。
  // 非 SSO 模式全靠 master token → authed 與 authedAdmin 同義。
  return { bearerOf, authed, authedAdmin: authed, roomAuth, principal: () => null, handle: null };
}

// SSO 授權：xitto 自管的角色名冊（IdP 不在管理範圍 → 授權由此決定）。見 docs/10-sso-design.md §4。
// 持久化於 <dir>/roles.json（email→role）；adminEmails 為 env 釘死的 admin（不落地、不可刪，防自鎖）。
export function createRoleStore({ dir, adminEmails = [], allowedDomain = '', openAccess = false } = {}) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const pinned = new Set(adminEmails.map(norm).filter(Boolean));
  // allowedDomain='*' 視同開放模式（任何 SSO 身份放行），而非字面網域。
  const open = openAccess || norm(allowedDomain) === '*';
  const domain = open ? '' : norm(allowedDomain).replace(/^@/, '');
  const ROLES = new Set(['admin', 'member', 'readonly']);
  const file = dir ? join(dir, 'roles.json') : null;
  const roles = new Map(); // email -> role（不含釘死 admin）
  if (file && existsSync(file)) {
    try { const o = JSON.parse(readFileSync(file, 'utf8')); for (const [e, r] of Object.entries(o || {})) if (ROLES.has(r)) roles.set(norm(e), r); } catch { /* 壞檔略過 */ }
  }
  const persist = () => { if (!file) return; try { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify(Object.fromEntries(roles))); } catch { /* 略 */ } };
  // 判角色（不含 master-token break-glass，那在 adapter 層）：釘死 admin → 名冊 → 網域放行 → 開放模式 → 皆無回 null。
  // openAccess（開放模式）：只要 SSO 通過即給 member，不看名冊/網域；仍尊重 XITTO_ADMIN_EMAILS 指定的 admin。
  const roleOf = (principal) => {
    if (!principal) return null;
    const email = norm(principal.email);
    // 明確授權（皆需已驗證 email）：釘死 admin → 名冊 → 網域放行(member)。
    if (email && principal.email_verified !== false) {
      if (pinned.has(email)) return 'admin';
      if (roles.has(email)) return roles.get(email);
      if (domain && email.endsWith('@' + domain)) return 'member';
    }
    if (open) return 'member'; // 開放模式：任何 SSO 已認證身份 → member（不看名冊/網域，email 可缺）
    return null;
  };
  return {
    roleOf,
    list: () => [
      ...[...pinned].map((email) => ({ email, role: 'admin', pinned: true })),
      ...[...roles].filter(([e]) => !pinned.has(e)).map(([email, role]) => ({ email, role, pinned: false })),
    ],
    set(email, role) {
      const e = norm(email); if (!e || !ROLES.has(role)) return { ok: false, error: 'email 或 role 無效（role ∈ admin|member|readonly）' };
      if (pinned.has(e)) return { ok: false, error: 'env 釘死的 admin 不可經 API 變更' };
      roles.set(e, role); persist(); return { ok: true, email: e, role };
    },
    remove(email) {
      const e = norm(email);
      if (pinned.has(e)) return { ok: false, error: 'env 釘死的 admin 不可刪除' };
      const had = roles.delete(e); if (had) persist(); return { ok: had, email: e, error: had ? undefined : 'not found' };
    },
  };
}

export function createServerApp({ model, getApiKey, resolveModel, models = [], token, auth, adminEmails = [], allowedEmailDomain = '', ssoOpen = false, stt = null, sttStreamFactory = null, baseDir = '.xitto-server', sandbox = true, concurrency = 2, local = false, publicOrigin = '', configPath, onReconfigure } = {}) {
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
  // SSO 授權名冊（xitto 自管）：SSO 開時查它決定 admin/member/readonly；SSO 關時仍可用 master token 經 /v1/admins 預先配置。
  const roleStore = createRoleStore({ dir: join(baseDir, 'auth'), adminEmails, allowedDomain: allowedEmailDomain, openAccess: ssoOpen });
  // 認證 adapter：注入的優先（SSO），否則用 defaultAuth 封裝的現有 token 邏輯 → 未注入即與過去完全一致。
  // roleStore 掛給 adapter，讓注入的 SSO adapter 共用同一份名冊。
  const authAdapter = auth || defaultAuth({ token });
  if (authAdapter && !authAdapter.roleStore) authAdapter.roleStore = roleStore;
  // SSO 模式旗標（有 /auth/* handle 即為 SSO）：據此決定頁面是否導向登入、以及是否注入 master token。
  const ssoActive = !!authAdapter.handle;
  // SSO 開啟且未登入 → 導向 IdP 登入（帶 returnTo 回原頁）。defaultAuth 無 handle → 永遠 false，現況不變。
  const needsLogin = (req) => ssoActive && !authAdapter.principal?.(req);
  const loginRedirect = (res, returnTo) => { res.writeHead(302, { location: '/auth/login?returnTo=' + encodeURIComponent(returnTo) }); res.end(); return true; };
  // 頁面注入的 token：SSO 開啟時清空（改靠 cookie session，避免把 master token 發給每個登入者 → 提權）。
  const pageToken = (t) => (ssoActive ? '' : (t || ''));
  const authed = (req) => authAdapter.authed(req);
  // 提權敏感端點（改名冊角色、改 provider 設定）：SSO 下限 admin；adapter 未提供則回退到 authed（非 SSO 同義）。
  const authedAdmin = (req) => (authAdapter.authedAdmin || authAdapter.authed)(req);
  const roomAuth = (req, room, need) => authAdapter.roomAuth(req, room, need);
  // 管理端點守門：非 admin 一律擋。未認證 → 401（無憑證）；已認證但非 admin（如 SSO member）→ 403（已登入、權限不足，符合「登入後不 401」）。
  const adminOnly = (req, res) => {
    if (authedAdmin(req)) return false;
    if (authed(req)) { json(res, 403, { error: 'forbidden（需 admin）' }); return true; }
    json(res, 401, { error: 'unauthorized' }); return true;
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
  // 語音轉文字（STT）：打 OpenAI 相容的 /v1/audio/transcriptions（本地 faster-whisper-server 等）。停用（未設 endpoint）回 null。
  const sttEnabled = !!(stt && stt.endpoint);
  // cfg 預設用啟用中的 stt；/v1/stt/test 傳入未儲存的表單設定來試連線。
  const transcribe = async (buffer, contentType, cfg = stt) => {
    if (!cfg || !cfg.endpoint) return null;
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType || 'audio/webm' }), 'audio.webm');
    form.append('model', cfg.model || 'Systran/faster-whisper-large-v3');
    if (cfg.language) form.append('language', cfg.language);
    form.append('response_format', 'json');
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), cfg.timeoutMs || 30000);
    try {
      const r = await fetch(cfg.endpoint, { method: 'POST', headers: cfg.apiKey ? { authorization: 'Bearer ' + cfg.apiKey } : {}, body: form, signal: ac.signal });
      if (!r.ok) throw new Error('STT HTTP ' + r.status);
      const j = await r.json().catch(() => ({}));
      return String(j.text || '').trim();
    } finally { clearTimeout(timer); }
  };
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
    // readOnly（L2）：剝除 pack 的 mutating 工具（write/edit/bash/gen_doc…）→ agent 只能讀/查/答，不能改動共享 workspace。
    // 同時 getPlanMode:true 擋下 kernel 內建的 mutating 工具（memory_save/bash_bg 等殘留）。
    let pack = make({ cwd: workdir });
    if (spec.readOnly) pack = { ...pack, tools: () => pack.tools().filter((t) => !isMutating(t)), mutatingTools: [] };
    // 環境能力畫像：雲端託管容器 vs 使用者本機。決定哪些工具/技能對 agent 可見，並提示它環境邊界。
    //   workspaceFs：可讀寫「被分配的工作目錄」（雲端也有 → 雲端 agent 能查看自己的檔案目錄）。
    //   hostFs     ：可存取容器外主機任意路徑/絕對路徑（僅本地模式）。
    const caps = local ? ['workspaceFs', 'hostFs', 'shell', 'network'] : ['workspaceFs', 'shell', 'network'];
    const envNote = local
      ? '你運行在使用者本機。可自由讀寫上面的工作目錄；經授權時亦可存取指定的本機絕對路徑。'
      : '你運行在雲端託管容器。上面的「工作目錄」是分配給你的專屬工作區——你可以自由讀取、瀏覽（list）、建立、修改其中及所有子目錄的檔案，放心操作。但你無法存取容器外的主機路徑、其他工作區，或 /tmp、/app 等系統絕對路徑；也不要嘗試瀏覽本機任意資料夾（此環境不支援）。所有成品一律寫在工作目錄內。';
    const kernel = createKernel(pack, { cwd: workdir, model: runModel, getApiKey, resolveModel, sandbox: { enabled: sandbox }, getSandbox: () => sandbox, env: local ? 'local' : 'cloud', caps, envNote, confirm: async () => 'yes', autoExtractMemory: true, ...(spec.readOnly ? { getPlanMode: () => true } : {}), ...(ask ? { askUser: ask } : {}) });
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

  // 專案會議室：多人 + LLM 共享 workspace/上下文。每人一條 AI lane（並發、私有 session、各自可中斷），
  // 只在有人 @ai 時觸發；lane 的 sessionId 綁定該成員的私有 history，續接其提問線（跨回合）。
  // 房間並發上限：XITTO_ROOM_CONCURRENCY（預設 3）→ 一房多人同時 @ai 時的最大並行回合數，超出排隊。
  const rooms = createRoomStore({
    persistDir: join(baseDir, 'rooms'),
    maxConcurrency: Number(process.env.XITTO_ROOM_CONCURRENCY || 3),
    autoMinutes: process.env.XITTO_ROOM_AUTO_MINUTES !== '0', // 散會（最後一人離開）自動整理紀要；設 0 關閉
    // 決策/待辦即時沉澱：發言命中廉價正則 → 追加進該房工作區的「會議記錄.md」（零 token）；XITTO_ROOM_AUTO_LEDGER=0 關閉。
    onLedger: process.env.XITTO_ROOM_AUTO_LEDGER === '0' ? undefined
      : ({ room, kind, name, text }) => appendLedger(workspaceDir(baseDir, room.workspace, local), { kind, name, text }),

    runAiTurn: ({ room, input, emit, onAgent, readOnly, sessionId }) =>
      runKernel({ pack: room.pack, model: room.model || undefined, mode: 'turn', readOnly, input: expandFileRefs(input, workspaceDir(baseDir, room.workspace, local)), workspace: room.workspace, sessionId: sessionId || undefined },
        (ev) => { const m = mapEvent(ev); if (m) emit(m); }, undefined, onAgent),
    // 會議紀要：獨立 goal（docgen pack 拿 gen_doc、fresh session 不污染對話），把整段 transcript 整理成決策/待辦/摘要並產成檔。
    runMinutes: ({ room, transcript, filename, emit, onAgent }) =>
      runKernel({ pack: 'docgen', model: room.model || undefined, mode: 'goal', workspace: room.workspace, goal: minutesGoal(transcript, filename) },
        (ev) => { const m = mapEvent(ev); if (m) emit(m); }, undefined, onAgent),
  });

  // P2 即時字幕：WebSocket 音訊串流端點處理器。瀏覽器串音訊幀 → STT adapter → interim 廣播成字幕、final 走 say（重用 P1 管線）。
  // 未注入 sttStreamFactory（未啟用/未接串流後端）→ 回 false 收線。憑成員 token（query）鑑權，說話人＝該成員（各錄各麥）。
  const handleAudioStream = (req, conn) => {
    if (!sttStreamFactory) return false;
    const u = new URL(req.url, 'http://x');
    const m = u.pathname.match(/^\/v1\/rooms\/([^/]+)\/audio\/stream$/);
    if (!m) return false;
    const room = rooms.get(m[1]); if (!room) return false;
    const a = roomAuth(req, room, 'member'); if (!a.ok) return false;
    const memberId = a.memberId || u.searchParams.get('memberId') || '';
    if (!memberId) return false;
    const writeAllowed = !room.readonly || !!a.master;
    let adapter;
    try {
      adapter = sttStreamFactory(stt, {
        onInterim: (text) => { try { rooms.caption(m[1], memberId, text, false); } catch { /* 略 */ } },
        onFinal: (text) => {
          try { rooms.caption(m[1], memberId, '', true); } catch { /* 略 */ }               // 清字幕
          if (text && /[\p{L}\p{N}]/u.test(text)) {                                          // 有實質內容才發言（濾靜音/雜訊）
            const s = rooms.say(m[1], { memberId, text, writeAllowed, source: 'voice' });
            if (!s.error) log({ room: m[1], action: 'voice-stream', chars: text.length, triggered: s.triggered });
          }
        },
      });
    } catch { return false; }
    if (!adapter) return false;
    conn.on('message', (data, isBinary) => { if (isBinary && data.length) { try { adapter.push(data); } catch { /* 略 */ } } });
    conn.on('close', () => { try { adapter.end && adapter.end(); } catch { /* 略 */ } });
    return true;
  };

  const app = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    // SSO adapter 先攔（擁有 /auth/login|callback|logout 等）；defaultAuth 無 handle → 直接略過，零影響。
    if (authAdapter.handle && await authAdapter.handle(req, res)) return;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, packs: Object.keys(PACKS), model: model.id, tasks: tasks.stats() });

    // 「我是誰」（公開，前端據此顯示帳號 chip / 登出）：非 SSO → ssoActive:false；SSO 未登入 → authenticated:false。
    if (req.method === 'GET' && path === '/v1/me') {
      if (!ssoActive) return json(res, 200, { ssoActive: false });
      const p = authAdapter.principal?.(req);
      if (!p) return json(res, 200, { ssoActive: true, authenticated: false });
      return json(res, 200, { ssoActive: true, authenticated: true, name: p.name || '', email: p.email || '', role: roleStore.roleOf(p) || null });
    }

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
      if (needsLogin(req)) return loginRedirect(res, path);
      let html; try { html = webHtml(); } catch { return json(res, 500, { error: 'web UI 未找到' }); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html.replace(/__SERVER_TOKEN__/g, pageToken(token)).replace(/__PACKS__/g, JSON.stringify(Object.keys(PACKS))).replace(/__LOCAL__/g, local ? 'true' : 'false'));
    }

    // 「對話」網頁：同一 kernel 的另一個前端——對話式（mode:turn + 固定 sessionId 多輪、SSE 串流），
    // 與許願台（mode:goal、交付物導向）做出區別。共用同一組工作區（五層沉澱跨頁累積）。
    if (req.method === 'GET' && (path === '/chat' || path === '/chat.html')) {
      if (needsLogin(req)) return loginRedirect(res, path);
      let html; try { html = chatHtml(); } catch { return json(res, 500, { error: 'chat UI 未找到' }); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html.replace(/__SERVER_TOKEN__/g, pageToken(token)).replace(/__PACKS__/g, JSON.stringify(Object.keys(PACKS))).replace(/__LOCAL__/g, local ? 'true' : 'false'));
    }

    // 「會議室」網頁：主控台 vs 訪客兩種載入。
    // 主控台（無 ?room=）：注入 master token，可建房（operator 專用 URL，請自行前置保護/勿外流）。
    // 訪客（帶 ?room=，即邀請連結）：不注入 master token，只憑 URL 上的邀請碼加入 → 換得成員 token。
    if (req.method === 'GET' && (path === '/room' || path === '/room.html')) {
      const guest = url.searchParams.has('room');
      // SSO 開啟：主控台（無 ?room=）未登入 → 導向登入；訪客（帶 ?room= 邀請連結）仍走邀請碼，不強制登入。
      if (!guest && needsLogin(req)) return loginRedirect(res, path);
      let html; try { html = roomHtml(); } catch { return json(res, 500, { error: 'room UI 未找到' }); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // __PUBLIC_ORIGIN__：伺服器建議的對外網址（區網 IP / 域名）→ host 在 localhost 開頁時，邀請連結改用它。
      return res.end(html.replace(/__SERVER_TOKEN__/g, guest ? '' : pageToken(token)).replace(/__PACKS__/g, JSON.stringify(Object.keys(PACKS))).replace(/__LOCAL__/g, local ? 'true' : 'false').replace(/__STT__/g, sttEnabled ? 'true' : 'false').replace(/__PUBLIC_ORIGIN__/g, () => publicOrigin || ''));
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

    // ── SSO 角色名冊（operator only）：xitto 自管 admin/member/readonly，供 SSO 授權查詢（見 docs/10-sso-design.md §4/§5）──
    // SSO 未開時也能用（master token），供上線前預先配置名冊。env 釘死的 admin 標 pinned、不可改/刪。
    if (path === '/v1/admins' && req.method === 'GET') {
      if (adminOnly(req, res)) return;
      return json(res, 200, { roles: roleStore.list() });
    }
    if (path === '/v1/admins' && req.method === 'POST') {
      if (adminOnly(req, res)) return;
      const b = await readBody(req); const r = roleStore.set(b.email, b.role);
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, email: r.email, role: r.role } : { error: r.error });
    }
    const mAdminDel = path.match(/^\/v1\/admins\/(.+)$/);
    if (mAdminDel && req.method === 'DELETE') {
      if (adminOnly(req, res)) return;
      const r = roleStore.remove(decodeURIComponent(mAdminDel[1]));
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, email: r.email } : { error: r.error });
    }

    // 設定入口（master only）：復用引導頁，改成「新增/更新一個 provider」語境。POST /v1/setup 合併進既有 providers.json 後熱重載。
    if (req.method === 'GET' && path === '/settings') {
      if (adminOnly(req, res)) return;
      // 現有設定 → 注入頁面（含 baseUrl 供編輯預填，但不含 apiKey 避免外洩；hasKey 標記是否已設 key）：
      // [{provider,api,baseUrl,hasKey,models:[{id,name,default}]}]。
      let existing = [];
      try {
        const cfg = loadProvidersConfig(providersConfigPath(configPath));
        existing = Object.entries(cfg.providers || {}).map(([provider, p]) => ({
          provider, api: p.api || 'openai-completions', baseUrl: p.baseUrl || '', hasKey: !!p.apiKey,
          models: (p.models || []).map((m) => ({ id: m.id, name: m.name || m.id, default: m.id === cfg.defaultModel, image: Array.isArray(m.input) && m.input.includes('image') })),
        }));
      } catch { /* 尚無檔 → 空清單 */ }
      // STT 現況注入頁面（不含 apiKey；hasKey 標記是否已設）→ UI 預填、可就地改。
      const sttPage = { endpoint: stt?.endpoint || '', model: stt?.model || '', language: stt?.language || '', hasKey: !!stt?.apiKey, enabled: !!(stt && stt.endpoint) };
      const html = SETUP_HTML
        .replace('<h1>初始設定</h1>', '<h1>模型設定</h1>')
        .replace(/尚未偵測到 provider 設定（<code>providers.json<\/code>）。填入要用的模型服務，儲存後服務會自動啟動——不需要重進容器。/, '在此新增或更新模型服務（provider / model）。既有設定不會被覆蓋；儲存後服務自動重載，可繼續新增。')
        .replace('/*EXISTING*/null', JSON.stringify(existing))
        .replace('/*STT*/null', JSON.stringify(sttPage));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (req.method === 'POST' && path === '/v1/setup') {
      if (adminOnly(req, res)) return;
      const body = await readBody(req);
      const cfgPath = providersConfigPath(configPath);
      let base = null; try { base = loadProvidersConfig(cfgPath); } catch { /* 尚無檔 → 等同新建 */ }
      let cfg;
      if (body.deleteProvider || body.deleteModel) {
        // 刪除：整個 provider，或某顆 model（其 provider 若因此空掉一併移除）。
        if (!base || !base.providers) return json(res, 400, { error: '尚無任何模型設定' });
        const providers = {};
        for (const [name, p] of Object.entries(base.providers)) {
          if (name === body.deleteProvider) continue;
          let models = p.models || [];
          if (body.deleteModel) models = models.filter((m) => m.id !== body.deleteModel);
          if (body.deleteModel && models.length === 0) continue; // model 刪光 → 順手移除空 provider
          providers[name] = { ...p, models };
        }
        const allIds = Object.values(providers).flatMap((p) => (p.models || []).map((m) => m.id));
        if (!allIds.length) return json(res, 400, { error: '不能刪除最後一個模型（服務至少需保留一個可用模型）' });
        // 預設被刪 → 回落到剩下的第一個，避免 providers.json 指向不存在的 defaultModel。
        const defaultModel = allIds.includes(base.defaultModel) ? base.defaultModel : allIds[0];
        cfg = { ...base, providers, defaultModel };
        try { buildModel(cfg, cfg.defaultModel); } catch (e) { return json(res, 400, { error: e.message }); }
      } else if (body.setDefault && !body.provider) {
        // 輕量操作：只把「已配置的某個 model」設為預設，不需重填 provider/baseUrl/apiKey。
        if (!base || !base.providers) return json(res, 400, { error: '尚無任何模型設定' });
        const exists = Object.values(base.providers).some((p) => (p.models || []).some((m) => m.id === body.setDefault));
        if (!exists) return json(res, 400, { error: `未知 model「${body.setDefault}」，無法設為預設` });
        cfg = { ...base, defaultModel: body.setDefault };
        try { buildModel(cfg, cfg.defaultModel); } catch (e) { return json(res, 400, { error: e.message }); }
      } else {
        // 編輯既有 provider 時 API Key 留空 = 沿用舊 key（頁面為安全不回顯舊 key，故留空代表「不變更」）。
        const eff = (body.provider && !String(body.apiKey || '').trim() && base?.providers?.[body.provider]?.apiKey)
          ? { ...body, apiKey: base.providers[body.provider].apiKey } : body;
        try { cfg = mergeSetupConfig(base, eff); buildModel(cfg, cfg.defaultModel); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      try { mkdirSync(dirname(cfgPath), { recursive: true }); writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); }
      catch (e) { return json(res, 500, { error: '寫入設定失敗：' + e.message }); }
      log({ action: 'reconfigure', provider: Object.keys(body.provider ? { [body.provider]: 1 } : {})[0], model: body.modelId });
      json(res, 200, { ok: true, path: cfgPath, reload: !!onReconfigure });
      // 回應送達後熱重載（close 現有 server → 用同 opts 重起，載入新設定）。無 onReconfigure（如注入式啟動）則需手動重啟。
      if (onReconfigure) setTimeout(() => { try { onReconfigure(); } catch (e) { console.error('熱重載失敗：', e.message); } }, 300);
      return;
    }

    // STT 設定（master only）：存進 <baseDir>/stt.json → 熱重載。endpoint 留空＝停用錄音。
    // apiKey 留空＝沿用現有（不必每次重填）。存過後即以此檔為準，不再看 env（見 startServer 的優先序）。
    if (req.method === 'POST' && path === '/v1/stt') {
      if (adminOnly(req, res)) return;
      const body = await readBody(req);
      const sttFile = join(baseDir, 'stt.json');
      let cur = {}; try { cur = JSON.parse(readFileSync(sttFile, 'utf8')); } catch { /* 尚無檔 */ }
      const next = {
        endpoint: String(body.endpoint ?? cur.endpoint ?? '').trim(),
        model: String(body.model ?? cur.model ?? '').trim(),
        language: String(body.language ?? cur.language ?? '').trim(),
        apiKey: (body.apiKey != null && body.apiKey !== '') ? String(body.apiKey) : (cur.apiKey || ''),
      };
      if (next.endpoint && !/^https?:\/\//.test(next.endpoint)) return json(res, 400, { error: 'endpoint 需為 http(s) 網址' });
      try { mkdirSync(baseDir, { recursive: true }); writeFileSync(sttFile, JSON.stringify(next, null, 2)); }
      catch (e) { return json(res, 500, { error: '寫入 STT 設定失敗：' + e.message }); }
      log({ action: 'stt-config', enabled: !!next.endpoint, model: next.model || undefined });
      json(res, 200, { ok: true, enabled: !!next.endpoint, reload: !!onReconfigure });
      if (onReconfigure) setTimeout(() => { try { onReconfigure(); } catch (e) { console.error('熱重載失敗：', e.message); } }, 300);
      return;
    }

    // STT 端點連線測試（master only）：用未儲存的表單設定 + 一小段靜音 WAV 打一次，確認端點可連/模型可用（存前先驗，免盲存）。
    if (req.method === 'POST' && path === '/v1/stt/test') {
      if (adminOnly(req, res)) return;
      const body = await readBody(req);
      const endpoint = String(body.endpoint || '').trim();
      if (!/^https?:\/\//.test(endpoint)) return json(res, 400, { error: 'endpoint 需為 http(s) 網址' });
      let saved = {}; try { saved = JSON.parse(readFileSync(join(baseDir, 'stt.json'), 'utf8')); } catch { /* 尚無檔 */ }
      const cfg = {
        endpoint,
        model: String(body.model || '').trim() || undefined,
        language: String(body.language || '').trim() || undefined,
        // apiKey 留空＝沿用已存的（避免在測試時要重填）
        apiKey: (body.apiKey != null && body.apiKey !== '') ? String(body.apiKey) : (saved.apiKey || (stt && stt.apiKey) || ''),
        timeoutMs: 15000,
      };
      // 0.2s / 16kHz / 單聲道 / 16-bit 靜音 WAV（44-byte header + 全 0 PCM）——只為驗端點可連、模型名可用。
      const rate = 16000, n = Math.floor(0.2 * rate), dataSize = n * 2, wav = Buffer.alloc(44 + dataSize);
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVE', 8);
      wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
      try { const text = await transcribe(wav, 'audio/wav', cfg); return json(res, 200, { ok: true, sample: text || '' }); }
      catch (e) { return json(res, 502, { ok: false, error: e.message }); }
    }

    // 測試對話（admin only）：真打一次極短 LLM 呼叫，確認某 model 的 provider/baseUrl/key 端到端可用。
    // body：{ modelId }（測已儲存的 model）或 { provider, api, baseUrl, apiKey, modelId }（測表單裡未儲存的設定；apiKey 留空=沿用既有）。
    if (req.method === 'POST' && path === '/v1/setup/test') {
      if (adminOnly(req, res)) return;
      const body = await readBody(req);
      let m, getKey;
      try {
        if (body.baseUrl && body.provider && body.modelId) {
          let b = body;
          if (!String(body.apiKey || '').trim()) {
            try { const base = loadProvidersConfig(providersConfigPath(configPath)); const k = base?.providers?.[body.provider]?.apiKey; if (k) b = { ...body, apiKey: k }; } catch { /* 無檔略過 */ }
          }
          const built = buildModel(buildSetupConfig(b), b.modelId); m = built.model; getKey = built.getApiKey;
        } else if (body.modelId) {
          const built = buildModel(loadProvidersConfig(providersConfigPath(configPath)), body.modelId); m = built.model; getKey = built.getApiKey;
        } else return json(res, 400, { error: '需指定 modelId（或完整 provider 設定）' });
      } catch (e) { return json(res, 400, { error: e.message }); }
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 20000);
      try {
        const apiKey = getKey ? await getKey(m.provider) : undefined;
        if (!apiKey) return json(res, 200, { ok: false, model: m.id, error: '缺少 API Key（或 ${ENV_VAR} 未設）' });
        const ctx = { systemPrompt: '你是連線測試助手。', messages: [{ role: 'user', content: [{ type: 'text', text: '請只回覆兩個字：OK' }], timestamp: Date.now() }] };
        const r = await completeSimple(m, ctx, { maxTokens: 16, apiKey, signal: ac.signal, cacheRetention: cacheRetentionFor(m) });
        const reply = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
        // 拿到非空回覆才算成功：completeSimple 對連線失敗常是「不拋錯、回空內容」，故以「有無實際回覆」判定連通。
        if (!reply) return json(res, 200, { ok: false, model: m.id, error: '無回覆——連線可能失敗，請檢查 Base URL／API Key／網路' });
        return json(res, 200, { ok: true, model: m.id, reply: reply.slice(0, 200) });
      } catch (e) {
        const msg = ac.signal.aborted ? '逾時（20s）——檢查 Base URL／網路／金鑰' : (e.message || String(e));
        return json(res, 200, { ok: false, model: m.id, error: String(msg).slice(0, 300) });
      } finally { clearTimeout(timer); }
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
      for (const s of r.sessionIds || [r.sessionId]) dropSession(s); // 每條 lane 的私有 session 都要聯刪
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
      // SSO 登入者：用已驗證身份當顯示名（真實身份，不信任前端傳入）→ 多人 @ai 認得誰是誰（room-multiuser-ai L2）。
      const who = authAdapter.principal?.(req);
      const r = rooms.join(mJoin[1], (who && (who.name || who.email)) || body.name);
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
      // 破壞性把關（L2）：唯讀房的非主持人發言 → writeAllowed=false → 其 @ai 回合唯讀，不能改共享檔。
      const writeAllowed = !room.readonly || !!auth.master;
      const r = rooms.say(mSay[1], { memberId: auth.memberId || body.memberId, text: body.text, writeAllowed });
      if (r.error) return json(res, r.code || 400, { error: r.error });
      log({ room: mSay[1], action: 'say', triggered: r.triggered });
      return json(res, 200, r);
    }

    // 中止「自己那條 lane」進行中的 AI 回合（憑成員 token）：各停各的，不影響別人。
    const mStop = path.match(/^\/v1\/rooms\/([^/]+)\/stop$/);
    if (req.method === 'POST' && mStop) {
      const room = rooms.get(mStop[1]); if (!room) return json(res, 404, { error: 'room not found' });
      const authStop = roomAuth(req, room, 'member'); if (!authStop.ok) return json(res, 401, { error: '需要成員 token' });
      const r = rooms.stop(mStop[1], authStop.memberId);
      if (r && r.error) return json(res, r.code || 400, { error: r.error });
      log({ room: mStop[1], action: 'stop' });
      return json(res, 200, { ok: true });
    }

    // 生成會議紀要（憑成員 token）：非同步跑（成品/狀態經 SSE 廣播），立即回 202。
    const mMinutes = path.match(/^\/v1\/rooms\/([^/]+)\/minutes$/);
    if (req.method === 'POST' && mMinutes) {
      const room = rooms.get(mMinutes[1]); if (!room) return json(res, 404, { error: 'room not found' });
      if (!roomAuth(req, room, 'member').ok) return json(res, 401, { error: '需要成員 token' });
      const r = rooms.minutes(mMinutes[1]); // 不 await：交給 SSE 廣播進度與結果
      if (r && r.error) return json(res, r.code || 400, { error: r.error });
      log({ room: mMinutes[1], action: 'minutes' });
      return json(res, 202, { ok: true });
    }

    // 房間事件流（SSE，憑邀請碼或成員 token）：即時收「他人發言 + AI 串流 + 成員進出 + 狀態」；連上先回放近況。
    const mRoomEv = path.match(/^\/v1\/rooms\/([^/]+)\/events$/);
    if (req.method === 'GET' && mRoomEv) {
      const room = rooms.get(mRoomEv[1]); if (!room) return json(res, 404, { error: 'room not found' });
      const evAuth = roomAuth(req, room, 'read'); if (!evAuth.ok) return json(res, 401, { error: '需要邀請碼或成員 token' });
      sseHead(res);
      // presence：成員（有 memberId）的 SSE 連線 = 上線；斷線即下線（invite 訪客無 memberId → 不計）。
      const offline = rooms.connect(mRoomEv[1], evAuth.memberId);
      // 事件帶 SSE id（用訊息 id）→ 斷線重連時瀏覽器自動回傳 Last-Event-ID，服務端只補發其後的訊息（省頻寬）。
      const sse = (o, id) => res.write((id ? `id: ${id}\n` : '') + `data: ${JSON.stringify(o)}\n\n`);
      sse({ type: 'hello', room: rooms.view(mRoomEv[1]) });
      // 只補發 Last-Event-ID 之後的訊息；找不到（已滾出緩衝）→ 全補發，客戶端再按 id 去重兜底。
      const lastId = req.headers['last-event-id'];
      const msgs = rooms.snapshot(mRoomEv[1]).messages;
      let from = 0;
      if (lastId) { const i = msgs.findIndex((m) => m.id === lastId); if (i >= 0) from = i + 1; }
      for (let k = from; k < msgs.length; k++) sse({ type: 'say', message: msgs[k], replay: true }, msgs[k].id);
      const unsub = rooms.subscribe(mRoomEv[1], (ev) => sse(ev, ev.type === 'say' ? ev.message?.id : undefined));
      req.on('close', () => { try { unsub(); } catch { /* 略 */ } try { offline(); } catch { /* 略 */ } });
      return;
    }

    // 打字中（憑成員 token，transient）：廣播「X 正在輸入…」給全員。body.on 布林。
    const mTyping = path.match(/^\/v1\/rooms\/([^/]+)\/typing$/);
    if (req.method === 'POST' && mTyping) {
      const room = rooms.get(mTyping[1]); if (!room) return json(res, 404, { error: 'room not found' });
      const authT = roomAuth(req, room, 'member'); if (!authT.ok) return json(res, 401, { error: '需要成員 token' });
      const body = await readBody(req);
      const r = rooms.typing(mTyping[1], authT.memberId || body.memberId, body.on);
      if (r && r.error) return json(res, r.code || 400, { error: r.error });
      return json(res, 200, { ok: true });
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
      // 主動簡報：上傳的是可讀文件 → 抽文字讓 AI 主動說明+提議下一步（不等 @ai）。
      // fire-and-forget、失敗靜默、不阻塞上傳回應；XITTO_ROOM_AUTO_BRIEF=0 可關；過大檔跳過避免抽取拖慢。
      if (process.env.XITTO_ROOM_AUTO_BRIEF !== '0' && r.buffer.length <= 4 * 1048576) {
        try {
          let text = '';
          if (isDocFile(full)) text = extractDocText(full);
          else if (/\.(md|markdown|txt|csv|tsv|json|ya?ml|log|html?|xml)$/i.test(full)) text = r.buffer.toString('utf8');
          if (text && text.trim()) rooms.autoBrief(mRoomUpload[1], { name: basename(full), text });
        } catch { /* 靜默：簡報失敗不影響上傳 */ }
      }
      return json(res, 200, { ok: true, name: basename(full), size: r.buffer.length, sub: rel });
    }

    // 錄音轉文字（憑成員 token）：接一段音訊 → STT → 以「該成員身份」發言（各錄各麥 → 說話人天生正確，免 diarization）。
    // 轉出的文字走與打字發言完全相同的路徑（廣播 / pending / 決策待辦 ledger / 散會紀要），零額外管線。
    const mAudio = path.match(/^\/v1\/rooms\/([^/]+)\/audio$/);
    if (req.method === 'POST' && mAudio) {
      const room = rooms.get(mAudio[1]); if (!room) return json(res, 404, { error: 'room not found' });
      const authA = roomAuth(req, room, 'member'); if (!authA.ok) return json(res, 401, { error: '需要成員 token' });
      const memberId = authA.memberId || (url.searchParams.get('memberId') || '');
      if (!memberId) return json(res, 403, { error: '請先加入房間' });
      if (!sttEnabled) return json(res, 501, { error: '此部署未啟用語音轉文字（設 XITTO_STT_ENDPOINT）' });
      const r = await readRaw(req, Number(process.env.XITTO_MAX_AUDIO || 25 * 1024 * 1024));
      if (r.over) return json(res, 413, { error: '音訊過大' });
      if (!r.buffer || !r.buffer.length) return json(res, 200, { ok: true, text: '' });
      let text = '';
      try { text = await transcribe(r.buffer, req.headers['content-type']); }
      catch (e) { return json(res, 502, { error: 'STT 失敗：' + (e?.message || String(e)) }); }
      // 只在轉出「有實質內容」時才發言（過濾靜音/雜訊的空轉錄）。
      if (!text || !/[\p{L}\p{N}]/u.test(text)) return json(res, 200, { ok: true, text: '' });
      const said = rooms.say(mAudio[1], { memberId, text, writeAllowed: !room.readonly || !!authA.master, source: 'voice' });
      if (said.error) return json(res, said.code || 400, { error: said.error });
      log({ room: mAudio[1], action: 'voice', chars: text.length, triggered: said.triggered });
      return json(res, 200, { ok: true, text });
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
      if (body.model && !knownModel(body.model)) return json(res, 400, { error: `未知 model「${body.model}」，可用：${modelList.map((m) => m.id).join(', ')}` });
      // 本地絕對路徑：缺失自動建立（與 CLI 一致），指到既有檔案才 fail-fast 報錯。
      if (local && body.workspace && isAbsolute(body.workspace)) {
        try { ensureWorkdir(body.workspace); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      const t = tasks.enqueue({ pack, model: body.model || undefined, mode: body.mode, input: body.input, goal: body.goal, sessionId: body.sessionId, webhook: body.webhook, workspace: body.workspace, auto: routed });
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
    // 本機模式：在系統原生檔案管理器 / 終端開啟工作目錄（服務跑在使用者本機才有意義；遠端會開在伺服器上 → 擋掉）。
    if (req.method === 'POST' && (path === '/v1/workspaces/open-folder' || path === '/v1/workspaces/open-terminal')) {
      if (!local) return json(res, 400, { error: '僅本機模式（serve:local / --local）支援——遠端部署無法開啟你的本機資料夾' });
      const dir = workspaceDir(baseDir, url.searchParams.get('ws') || 'default', local);
      try { mkdirSync(dir, { recursive: true }); } catch { /* 略 */ }
      const term = path.endsWith('open-terminal'); const p = process.platform;
      let cmd, args;
      if (term) {
        if (p === 'darwin') { cmd = 'open'; args = ['-a', 'Terminal', dir]; }
        else if (p === 'win32') { cmd = 'cmd'; args = ['/c', 'start', 'cmd', '/K', 'cd', '/d', dir]; }
        else { cmd = 'x-terminal-emulator'; args = ['--working-directory=' + dir]; } // Linux 盡力而為
      } else {
        if (p === 'darwin') { cmd = 'open'; args = [dir]; }
        else if (p === 'win32') { cmd = 'explorer'; args = [dir.replace(/\//g, '\\')]; }
        else { cmd = 'xdg-open'; args = [dir]; }
      }
      // execFile 不走 shell（無注入風險）；explorer/部分命令成功也回非 0，忽略錯誤只記日誌。
      execFile(cmd, args, (err) => { if (err) log({ action: term ? 'open-terminal' : 'open-folder', error: err.message }); });
      log({ action: term ? 'open-terminal' : 'open-folder', dir });
      return json(res, 200, { ok: true, dir });
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
  // P2 即時字幕：接上 WebSocket 音訊串流升級（handleAudioStream 未啟用/鑑權失敗會回 false 收線）。
  attachUpgrade(app, handleAudioStream);
  return app;
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
  // 是否支援圖片（視覺輸入）：勾選 → input 宣告含 image（供未來多模態訊息與前端判斷）。
  if (body.image) model.input = ['text', 'image'];
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
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;width:min(520px,96vw);padding:26px;max-height:94vh;overflow-y:auto;position:relative}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.close{width:auto;margin:0 0 0 auto;padding:5px 10px;background:transparent;color:var(--dim);border:1px solid var(--line);border-radius:8px;font-size:15px;font-weight:400;line-height:1}
.close:hover{color:var(--fg);border-color:var(--accent)}
.mini{width:auto;margin:0 0 0 6px;padding:1px 8px;font-size:11px;font-weight:500;background:transparent;color:var(--accent);border:1px solid var(--line);border-radius:6px;vertical-align:middle}
.mini:hover{border-color:var(--accent)}
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
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.ghost:hover{border-color:var(--accent)}
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
.exist-top{display:flex;align-items:center;gap:6px}
.exist-act{margin-left:auto;display:flex;gap:6px;flex-shrink:0}
.mini.danger{color:var(--err);border-color:color-mix(in srgb,var(--err) 30%,var(--line))}
.mini.danger:hover{border-color:var(--err)}
</style></head><body>
<div class="card">
  <div class="brand"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#5b63e6"/><g fill="#fff"><path d="M11 21l8-8 1.6 1.6-8 8z" opacity=".95"/><path d="M20 9l.7 1.8L22.5 11.5l-1.8.7L20 14l-.7-1.8L17.5 11.5l1.8-.7z"/></g></svg><h1>初始設定</h1><button id="closeBtn" class="close" type="button" title="關閉（不變更）" hidden>✕ 關閉</button></div>
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
  <label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer;color:var(--fg)">
    <input type="checkbox" id="image" style="width:auto;margin:0"> 🖼 支援圖片（視覺輸入）——此模型可接收圖片訊息
  </label>
  <details><summary>進階（可留白用預設）</summary>
    <div class="grid2" style="margin-bottom:12px"><div><label>Context Window</label><input id="contextWindow" type="number" placeholder="128000"></div><div><label>Max Tokens</label><input id="maxTokens" type="number" placeholder="4096"></div></div>
  </details>
  <label id="defWrap" style="display:none;align-items:center;gap:8px;margin-top:14px;cursor:pointer;color:var(--fg)">
    <input type="checkbox" id="makeDefault" style="width:auto;margin:0"> 設為預設模型（新會議 / 未指定時用它）
  </label>
  <div class="msg" id="msg"></div>
  <div class="grid2"><div><button id="test" class="ghost" type="button" title="不儲存，先打一次對話確認可連線">🧪 測試對話</button></div><div><button id="save" type="button">儲存並啟動</button></div></div>
</div>
<div class="card" id="sttCard" style="display:none;margin-top:14px">
  <div class="brand" style="margin-bottom:4px"><h1 style="font-size:18px">🎙 語音轉文字（會議室錄音）</h1></div>
  <p class="sub" id="sttStatus"></p>
  <label>STT 端點（OpenAI 相容 <code>/v1/audio/transcriptions</code>）</label>
  <input id="sttEndpoint" placeholder="http://localhost:8000/v1/audio/transcriptions" autocomplete="off">
  <div class="hint">留空 = 停用會議室錄音鈕。本地可用 faster-whisper-server（見 <code>docs/13</code>）。</div>
  <div class="grid2">
    <div><label>模型</label><input id="sttModel" placeholder="Systran/faster-whisper-large-v3" autocomplete="off"></div>
    <div><label>語言碼（留白＝自動偵測）</label><input id="sttLang" placeholder="zh" autocomplete="off"></div>
  </div>
  <label>API Key（本地通常不需要）</label><input id="sttKey" type="password" placeholder="留空 = 不變更" autocomplete="off">
  <div class="msg" id="sttMsg"></div>
  <div class="grid2"><div><button id="sttTest" class="ghost" type="button" title="不儲存，先打一次確認 STT 端點可連線">🧪 測試語音端點</button></div><div><button id="sttSave" type="button">儲存語音設定</button></div></div>
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
// STT：/settings 注入現有語音設定（不含 apiKey，hasKey 標記）；首次引導頁為 null → 不顯示語音卡。
var STT=/*STT*/null;
if(STT){
  $("#sttCard").style.display="block";
  $("#sttEndpoint").value=STT.endpoint||"";$("#sttModel").value=STT.model||"";$("#sttLang").value=STT.language||"";
  if(STT.hasKey)$("#sttKey").placeholder="留空 = 沿用現有 API Key";
  $("#sttStatus").textContent=STT.enabled?"狀態：已啟用 — 會議室成員可錄音轉逐字稿。":"狀態：未啟用 — 填入 STT 端點即開啟。";
  $("#sttTest").onclick=async function(){
    var payload={endpoint:$("#sttEndpoint").value.trim(),model:$("#sttModel").value.trim(),language:$("#sttLang").value.trim(),apiKey:$("#sttKey").value};
    var m=$("#sttMsg");if(!payload.endpoint){m.textContent="請先填 STT 端點";m.className="msg err";return}
    m.textContent="測試連線中…";m.className="msg";
    var r;try{r=await fetch("/v1/stt/test",{method:"POST",headers:AUTH,body:JSON.stringify(payload)}).then(function(x){return x.json()})}catch(e){r={error:"無法連線到伺服器"}}
    if(!r||r.ok===false||r.error){m.textContent="✗ 端點測試失敗："+((r&&r.error)||"未知錯誤");m.className="msg err";return}
    m.textContent="✓ 端點可連線"+(r.sample?"（樣本回應："+esc(r.sample)+"）":"（靜音樣本無輸出屬正常）");m.className="msg ok";
  };
  $("#sttSave").onclick=async function(){
    var payload={endpoint:$("#sttEndpoint").value.trim(),model:$("#sttModel").value.trim(),language:$("#sttLang").value.trim(),apiKey:$("#sttKey").value};
    var m=$("#sttMsg");m.textContent="儲存中…";m.className="msg";
    var r;try{r=await fetch("/v1/stt",{method:"POST",headers:AUTH,body:JSON.stringify(payload)}).then(function(x){return x.json()})}catch(e){r={error:"無法連線到伺服器"}}
    if(!r||r.error){m.textContent=(r&&r.error)||"儲存失敗";m.className="msg err";return}
    m.textContent=(r.enabled?"已儲存並啟用":"已儲存（停用）")+"，服務重載中…";m.className="msg ok";
    var tries=0;var poll=async function(){tries++;try{var h=await fetch("/health",{cache:"no-store"}).then(function(x){return x.json()});if(h&&h.mode!=="setup"){location.reload();return}}catch(e){}if(tries>40){m.textContent="已儲存，請手動重新整理。";return}setTimeout(poll,800)};setTimeout(poll,1000);
  };
}
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
function esch(t,k){var e=$("#msg");e.textContent=t;e.className="msg "+k}
var showMsg=esch;
if(EXISTING){                              // 設定模式：顯示已配置的 provider/model 清單 + 允許設預設
  $("#defWrap").style.display="flex";
  var n=EXISTING.reduce(function(a,p){return a+p.models.length},0);
  var html='<div class="exist-h">目前已配置 '+EXISTING.length+' 個 provider · '+n+' 個模型（可編輯／刪除，或用下方表單新增／更新）：</div>';
  EXISTING.forEach(function(p,pi){
    html+='<div class="exist-p"><div class="exist-top"><b>'+esc(p.provider)+'</b> <span class="exist-m">'+esc(p.api||"")+'</span>'+
      '<span class="exist-act"><button class="mini" type="button" onclick="editProvider('+pi+')">編輯</button>'+
      '<button class="mini danger" type="button" onclick="delProvider('+pi+')">刪除</button></span></div><div class="exist-m">'+
      p.models.map(function(m){var lbl=esc(m.name||m.id)+(m.name&&m.name!==m.id?' ('+esc(m.id)+')':'')+(m.image?' 🖼':'');var head=m.default?'<span class="def">★ '+lbl+'（預設）</span>':lbl+' <button class="mini" type="button" onclick="setDefault(\\''+esc(m.id)+'\\')">設為預設</button>';return head+' <button class="mini" type="button" title="真打一次對話測試連線" onclick="testModel(\\''+esc(m.id)+'\\')">測試</button> <button class="mini danger" type="button" title="刪除此模型" onclick="delModel(\\''+esc(m.id)+'\\')">✕</button>'}).join('<br>')+'</div></div>';
  });
  $("#existing").innerHTML=html;
  $("#save").textContent="新增 / 更新模型";
  // 設定模式（已有 provider）：可直接關閉離開、不必操作。首次引導（EXISTING 為 null）則不給關，需先設定。
  var cb=$("#closeBtn");
  var close=function(){if(history.length>1)history.back();else location.href="/"};
  cb.hidden=false;cb.onclick=close;
  document.addEventListener("keydown",function(e){if(e.key==="Escape")close()});
}
// 把已配置的某個 model 設為預設（不需重填憑證）：POST {setDefault} → 熱重載後刷新頁面。
async function setDefault(id){
  var r;try{r=await fetch("/v1/setup",{method:"POST",headers:AUTH,body:JSON.stringify({setDefault:id})}).then(function(x){return x.json()})}catch(e){r={error:"無法連線到伺服器"}}
  if(!r||r.error)return showMsg((r&&r.error)||"設定失敗","err");
  showMsg("已設為預設，服務重載中…","ok");
  var tries=0;var poll=async function(){tries++;try{var h=await fetch("/health",{cache:"no-store"}).then(function(x){return x.json()});if(h&&h.mode!=="setup"){location.reload();return}}catch(e){}if(tries>40)return showMsg("已設定，請手動重新整理。","ok");setTimeout(poll,800)};setTimeout(poll,1000);
}
// 通用 /v1/setup 動作（刪除等）：POST → 顯示訊息 → 輪詢 /health 重載完成後刷新頁面。
async function doSetup(payload,okMsg){
  var r;try{r=await fetch("/v1/setup",{method:"POST",headers:AUTH,body:JSON.stringify(payload)}).then(function(x){return x.json()})}catch(e){r={error:"無法連線到伺服器"}}
  if(!r||r.error)return showMsg((r&&r.error)||"操作失敗","err");
  showMsg(okMsg,"ok");
  var tries=0;var poll=async function(){tries++;try{var h=await fetch("/health",{cache:"no-store"}).then(function(x){return x.json()});if(h&&h.mode!=="setup"){location.reload();return}}catch(e){}if(tries>40)return showMsg("已完成，請手動重新整理。","ok");setTimeout(poll,800)};setTimeout(poll,1000);
}
// 編輯既有 provider：把其欄位帶進下方表單（baseUrl 可改；API Key 留空=不變更；Model ID 同=更新、不同=新增）。
function editProvider(pi){
  var p=EXISTING&&EXISTING[pi];if(!p)return;
  $("#preset").value="custom";
  $("#provider").value=p.provider;$("#api").value=p.api||"openai-completions";$("#baseUrl").value=p.baseUrl||"";
  $("#apiKey").value="";$("#apiKey").placeholder=p.hasKey?"留空 = 沿用現有 API Key":"sk-…";
  var m0=(p.models&&p.models[0])||{};$("#modelId").value=m0.id||"";$("#modelName").value=(m0.name&&m0.name!==m0.id)?m0.name:"";
  $("#image").checked=!!m0.image;
  showMsg("編輯「"+p.provider+"」：API Key 留空則不變更；Model ID 相同為更新、不同為新增一顆。","ok");
  try{$("#provider").scrollIntoView({behavior:"smooth",block:"center"})}catch(e){}$("#provider").focus();
}
async function delProvider(pi){
  var p=EXISTING&&EXISTING[pi];if(!p)return;
  if(!confirm("刪除 provider「"+p.provider+"」及其所有模型？會改寫 providers.json 並熱重載服務。"))return;
  await doSetup({deleteProvider:p.provider},"已刪除 provider「"+p.provider+"」，服務重載中…");
}
async function delModel(id){
  if(!confirm("刪除模型「"+id+"」？"))return;
  await doSetup({deleteModel:id},"已刪除模型「"+id+"」，服務重載中…");
}
// 測試已儲存的某個 model：真打一次對話，回報成功/失敗（不改動設定）。
async function testModel(id){
  showMsg("測試「"+id+"」對話中…","ok");
  var r;try{r=await fetch("/v1/setup/test",{method:"POST",headers:AUTH,body:JSON.stringify({modelId:id})}).then(function(x){return x.json()})}catch(e){r={ok:false,error:"無法連線到伺服器"}}
  if(r&&r.ok)showMsg("✓ 「"+id+"」可對話 · 回覆："+esc(r.reply||"OK"),"ok");
  else showMsg("✗ 「"+id+"」測試失敗："+esc((r&&r.error)||"未知錯誤"),"err");
}
// 測試「表單裡（未儲存）的設定」：API Key 留空則沿用既有 provider 的 key。
async function testForm(){
  var b={provider:$("#provider").value.trim(),api:$("#api").value,baseUrl:$("#baseUrl").value.trim(),apiKey:$("#apiKey").value.trim(),modelId:$("#modelId").value.trim()};
  if(!b.provider||!b.baseUrl||!b.modelId)return showMsg("測試需要 Provider、Base URL、Model ID（API Key 留空則沿用既有）。","err");
  $("#test").disabled=true;showMsg("測試對話中…（最多 20 秒）","ok");
  var r;try{r=await fetch("/v1/setup/test",{method:"POST",headers:AUTH,body:JSON.stringify(b)}).then(function(x){return x.json()})}catch(e){r={ok:false,error:"無法連線到伺服器"}}
  $("#test").disabled=false;
  if(r&&r.ok)showMsg("✓ 連線成功 · 回覆："+esc(r.reply||"OK"),"ok");
  else showMsg("✗ 測試失敗："+esc((r&&r.error)||"未知錯誤"),"err");
}
$("#test").onclick=testForm;
$("#save").onclick=async function(){
  var body={provider:$("#provider").value.trim(),api:$("#api").value,baseUrl:$("#baseUrl").value.trim(),apiKey:$("#apiKey").value.trim(),modelId:$("#modelId").value.trim(),modelName:$("#modelName").value.trim(),contextWindow:Number($("#contextWindow").value)||undefined,maxTokens:Number($("#maxTokens").value)||undefined,image:$("#image").checked||undefined,makeDefault:$("#makeDefault").checked||undefined};
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
  // SSO 授權（見 docs/10-sso-design.md）：釘死的首任 admin email + 選填的網域放行；不設即封閉名冊。
  const adminEmails = opts.adminEmails ?? String(process.env.XITTO_ADMIN_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowedEmailDomain = opts.allowedEmailDomain ?? process.env.XITTO_ALLOWED_EMAIL_DOMAIN ?? '';
  // 開放模式（XITTO_SSO_OPEN=1 或 XITTO_ALLOWED_EMAIL_DOMAIN=*）：只要 SSO 通過即可用（給 member），不看名冊/網域。
  const ssoOpen = opts.ssoOpen ?? (process.env.XITTO_SSO_OPEN === '1' || allowedEmailDomain === '*');
  // 語音轉文字（STT）：優先序 opts（注入式）> 持久化設定檔（/settings UI 存的）> 環境變數（部署者設的）。
  // UI 一旦存過即以 <baseDir>/stt.json 為準（endpoint 留空＝停用），不必再靠 env、也不必重進容器。
  let sttSaved = null;
  try { const f = join(baseDir, 'stt.json'); if (existsSync(f)) sttSaved = JSON.parse(readFileSync(f, 'utf8')); } catch { /* 壞檔略，退回 env */ }
  const stt = opts.stt ?? sttSaved ?? (process.env.XITTO_STT_ENDPOINT ? {
    endpoint: process.env.XITTO_STT_ENDPOINT,
    model: process.env.XITTO_STT_MODEL || 'Systran/faster-whisper-large-v3',
    apiKey: process.env.XITTO_STT_KEY || '',
    language: process.env.XITTO_STT_LANGUAGE || '',
  } : null);
  // SSO 認證（純 opt-in）：設了 issuer 或顯式授權端點才啟用 OAuth2/OIDC；否則 auth=undefined → createServerApp 走 defaultAuth（現況）。
  let auth = opts.auth;
  const oidcIssuer = process.env.XITTO_OAUTH_ISSUER;
  const oidcAuthz = process.env.XITTO_OAUTH_AUTHZ_ENDPOINT;
  if (!auth && (oidcIssuer || oidcAuthz || process.env.XITTO_OAUTH_USERINFO_ENDPOINT)) {
    try {
      auth = oauth2Auth({
        issuer: oidcIssuer,
        authorizationEndpoint: oidcAuthz,
        tokenEndpoint: process.env.XITTO_OAUTH_TOKEN_ENDPOINT,
        jwksUri: process.env.XITTO_OAUTH_JWKS_URI,
        // 非 OIDC（無 id_token，如部分企業 CAS）：設 userinfo 端點 → 拿 access_token 取身份；PKCE 可關；logout 可連 IdP 單點登出。
        userinfoEndpoint: process.env.XITTO_OAUTH_USERINFO_ENDPOINT,
        userinfoTokenIn: process.env.XITTO_OAUTH_USERINFO_TOKEN_IN || 'query',
        tokenParamsIn: process.env.XITTO_OAUTH_TOKEN_PARAMS_IN || 'body',  // 部分 CAS 設 'query'（參數拼 url）
        usePkce: process.env.XITTO_OAUTH_PKCE !== '0',
        logoutEndpoint: process.env.XITTO_OAUTH_LOGOUT_ENDPOINT,
        logoutReturnParam: process.env.XITTO_OAUTH_LOGOUT_RETURN_PARAM || 'returnurl',
        postLogoutRedirect: process.env.XITTO_OAUTH_POST_LOGOUT_REDIRECT,
        clientId: process.env.XITTO_OAUTH_CLIENT_ID,
        clientSecret: process.env.XITTO_OAUTH_CLIENT_SECRET,
        redirectUri: process.env.XITTO_OAUTH_REDIRECT_URI,
        scopes: String(process.env.XITTO_OAUTH_SCOPES || 'openid email profile').split(/\s+/).filter(Boolean),
        cookieSecret: process.env.XITTO_COOKIE_SECRET,
        sessionTtl: parseTtl(process.env.XITTO_SESSION_TTL) || 8 * 3600,
        masterToken: token, // 保留為 break-glass / M2M（可設 XITTO_SERVER_TOKEN="" 關閉）
        secureCookie: process.env.XITTO_OAUTH_INSECURE_COOKIE !== '1',
      });
    } catch (e) { console.error(`❌ OAuth2 SSO 設定錯誤：${e.message}`); throw e; }
  }
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
  server = createServerApp({ model, getApiKey, resolveModel, models, token, auth, adminEmails, allowedEmailDomain, ssoOpen, stt, baseDir, sandbox, concurrency, local, publicOrigin, configPath: opts.configPath, onReconfigure });
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
    if (sttEnabled) console.log(`🎙 語音轉文字：已啟用（STT ${stt.endpoint} · model ${stt.model || 'default'}）→ 會議室可錄音轉逐字稿`);
  });
  return server;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) startServer();
