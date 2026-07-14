// Ink TUI driver — 把 kernel 接上 tui.js 的 store/handlers/App（對標 Claude Code 的全 TUI 體驗）。
// 常駐狀態列、串流即時重繪、Esc 中斷、權限 Select、@檔案/!bash/#記憶/斜線指令。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createKernel, turnNotice } from '../kernel/index.js';
import { createStore, mountTui, gutter } from './tui.js';
import { md } from './md-render.js';

// 取最有意義的參數當摘要（像 Claude Code：bash(npm test) 而非 bash({"command":...})）
export const summarize = (args) => {
  if (!args || typeof args !== 'object') return '';
  const v = args.command ?? args.path ?? args.pattern ?? args.query ?? args.url ?? args.name ?? args.topic ?? args.file;
  if (v != null && v !== '') return String(v).replace(/\s+/g, ' ').slice(0, 60);
  const s = JSON.stringify(args); return s === '{}' ? '' : (s.length > 60 ? s.slice(0, 57) + '…' : s);
};
const Y = (s) => `\x1b[33m${s}\x1b[39m`; const G = (s) => `\x1b[90m${s}\x1b[39m`; const R = (s) => `\x1b[31m${s}\x1b[39m`; const C = (s) => `\x1b[36m${s}\x1b[39m`; const Gn = (s) => `\x1b[32m${s}\x1b[39m`;

// token 數壓縮顯示：1234 → 1.2k（對標 Claude Code 進度列）
export const fmtTok = (n) => (n < 1000 ? String(n) : (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k');

// 工具卡（對標 Claude Code）：⏺ name(args) 標頭 + ⎿ 多行結果,過長摺疊成「… +N 行」。純函數,可測。
// dur：單一工具耗時（如 '1.2s'），附在標頭尾（灰）。
export function toolBlock(name, summary, result, isError, dur) {
  const head = Y(`⏺ ${name}`) + (summary ? G(`(${summary})`) : '') + (dur ? G(` ${dur}`) : '');
  const raw = (result?.content || []).map((c) => c.text || '').join('\n').replace(/\s+$/, '');
  if (!raw.trim()) return head + '\n' + (isError ? R('  ⎿ ✗') : Gn('  ⎿ ✓'));
  const lines = raw.split('\n');
  const MAX = isError ? 12 : 10;
  const shown = lines.slice(0, MAX).map((l, i) => '  ' + (i === 0 ? '⎿ ' : '  ') + l.slice(0, 200));
  let out = head + '\n' + (isError ? R : G)(shown.join('\n'));
  if (lines.length > MAX) out += '\n' + G(`     … +${lines.length - MAX} 行`);
  return out;
}

// 工具顯示名（對標 Claude Code 的 ⏺ Read(...) 友善名；未列出的用原名）。
const TOOL_LABELS = {
  read: '讀檔', write: '寫檔', edit: '編輯', ls: '列目錄', glob: '找檔', grep: '搜尋',
  bash: 'bash', bash_bg: '背景執行', bash_output: '背景輸出', bash_kill: '停止背景',
  web_search: '搜尋網路', web_fetch: '抓網頁', http: 'HTTP',
  git_status: 'git 狀態', git_diff: 'git diff', git_log: 'git log', git_commit: 'git commit',
  todo_write: '待辦', spawn_agent: '子 agent', spawn_agents: '平行子 agent',
  security_review: '安全審查', code_review: '程式碼審查',
  lsp_diagnostics: 'LSP 診斷', lsp_definition: '跳定義', lsp_hover: 'hover', lsp_symbols: '符號大綱',
  lsp_references: '找引用', lsp_rename: '重命名', lsp_workspace_symbols: '符號搜尋',
};
export const toolLabel = (name) => TOOL_LABELS[name] || name;

// 讀類工具的「摘要一行」（對標 Claude Code）：read/glob/ls 的結果是給模型的上下文，
// 使用者只需看到「讀了 N 行 / 找到 N 個檔」，不該把整份檔案內容/清單灌進轉錄。
// 回 null＝沒有可摘要的形態（錯誤 JSON、bash 等）→ 交給一般 toolBlock 顯示完整結果。純函數,可測。
export function toolDigest(name, result) {
  const raw = (result?.content || []).map((c) => c.text || '').join('\n');
  if (name === 'glob') { try { const o = JSON.parse(raw); if (typeof o.count === 'number') return `${o.count} 個檔案`; } catch { /* 非預期形態 */ } return null; }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('{')) return null; // 空 / 錯誤 JSON → 交給 toolBlock
  if (name === 'read') {
    const n = (raw.match(/^\s*\d+\t/gm) || []).length;    // 帶行號的內容行數
    if (!n) return null;
    const more = raw.match(/還有\s*(\d+)\s*行/);
    return `讀取 ${n} 行` + (more ? `（+${more[1]} 未顯示）` : '');
  }
  if (name === 'ls') return `${raw.split('\n').filter((l) => l.trim()).length} 項`;
  return null;
}

// 工具結果卡（對標 Claude Code）：讀類工具用摘要一行，其餘沿用 toolBlock 顯示完整結果。純函數,可測。
export function toolResultBlock(name, summary, result, isError, dur) {
  const digest = isError ? null : toolDigest(name, result);
  if (digest) {
    const head = Y(`⏺ ${toolLabel(name)}`) + (summary ? G(`(${summary})`) : '') + (dur ? G(` ${dur}`) : '');
    return head + '\n' + G(`  ⎿ ${digest}`);
  }
  return toolBlock(toolLabel(name), summary, result, isError, dur);
}

// 彩色 diff 區塊：以「hunk」呈現——變動行（綠 + / 紅 -）+ 前後各 2 行上下文（灰），
// 跨 hunk 折疊為 ⋮，對標 Claude Code / xitto-code 的 unified diff。渲染 kernel 掛在 result._diff 的行級 diff。
export function diffBlock(d, dur) {
  if (!d) return '';
  const head = G('  ⎿ ') + Gn(`+${d.added}`) + ' ' + R(`-${d.removed}`) + G(' 行') + (dur ? G(` ${dur}`) : '');
  if (d.tooBig) return head + G('（差異過大,省略內容）');
  const lines = d.lines || [];
  const changed = lines.map((l, i) => (l.t !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return '';
  const CTX = 2;
  const show = new Set();
  for (const i of changed) for (let j = i - CTX; j <= i + CTX; j++) if (j >= 0 && j < lines.length) show.add(j);
  const idxs = [...show].sort((a, b) => a - b);
  const MAX = 40;
  const out = [];
  let prev = -1;
  for (const i of idxs.slice(0, MAX)) {
    if (prev >= 0 && i > prev + 1) out.push(C('    ⋮')); // 折疊未顯示的區間
    const l = lines[i];
    out.push(l.t === '+' ? Gn('    + ' + l.s.slice(0, 200)) : l.t === '-' ? R('    - ' + l.s.slice(0, 200)) : G('      ' + l.s.slice(0, 200)));
    prev = i;
  }
  if (idxs.length > MAX) out.push(G(`     … +${idxs.length - MAX} 行`));
  return head + '\n' + out.join('\n');
}

// 核准前變更預覽（對標 xitto-code）：write/edit 在權限選單先給你看「要改什麼」，不再盲核准。純函數,可測。
export function previewChange(name, args) {
  if (!args || typeof args !== 'object' || !args.path) return '';
  if (name === 'write') {
    const lines = String(args.content ?? '').split('\n');
    const head = C(`寫入 ${args.path}`) + G(` (${lines.length} 行)`);
    const body = lines.slice(0, 12).map((l) => Gn('  + ' + l.slice(0, 200)));
    const more = lines.length > 12 ? [G(`  … +${lines.length - 12} 行`)] : [];
    return [head, ...body, ...more].join('\n') + '\n';
  }
  if (name === 'edit') {
    const oldL = String(args.oldText ?? '').split('\n');
    const newL = String(args.newText ?? '').split('\n');
    const head = C(`編輯 ${args.path}`) + (args.replaceAll ? G(' (全部)') : '');
    const del = oldL.slice(0, 8).map((l) => R('  - ' + l.slice(0, 200)));
    const add = newL.slice(0, 8).map((l) => Gn('  + ' + l.slice(0, 200)));
    const more = (oldL.length > 8 || newL.length > 8) ? [G('  …')] : [];
    return [head, ...del, ...add, ...more].join('\n') + '\n';
  }
  return '';
}

// 斜線指令多層聯動補全（對標 Claude Code）：L1 指令名 → L2 參數 → L3 子項。純函數,可測。
// argsFor(cmd) 回該指令的參數選項 [{value, desc, sub?}]：value 尾隨空白＝接受後自動聯動下一層；
// 帶 sub() 的選項再往下展一層。hasArgs（Set）：L1 判斷哪些指令要加尾隨空白，避免對每個指令都呼叫 argsFor。
const bareVal = (o) => (typeof o === 'string' ? o : o.value).replace(/\s+$/, '');
export function slashComplete(text, { slashMap, hasArgs, argsFor }) {
  const m3 = text.match(/^(\/[a-z]+)\s+(\S+)\s+(\S*)$/);
  if (m3) {
    const opt = (argsFor(m3[1]) || []).find((o) => bareVal(o) === m3[2] && typeof o.sub === 'function');
    if (!opt) return null;
    const items = opt.sub().filter((o) => bareVal(o).startsWith(m3[3]));
    return items.length ? { start: text.length - m3[3].length, items } : null;
  }
  const m2 = text.match(/^(\/[a-z]+)\s+(\S*)$/);
  if (m2) {
    const opts = argsFor(m2[1]);
    if (!opts) return null;
    const items = opts.filter((o) => bareVal(o).startsWith(m2[2]));
    return items.length ? { start: text.length - m2[2].length, items } : null;
  }
  const sm = text.match(/^\/(\S*)$/);
  if (sm) {
    const items = Object.keys(slashMap).filter((c) => c.startsWith('/' + sm[1])).map((c) => ({ value: hasArgs.has(c) ? c + ' ' : c, desc: slashMap[c] }));
    return items.length ? { start: 0, items } : null;
  }
  return null;
}

const SLASH = { '/help': '說明', '/model': '切換模型', '/goal': '目標循環', '/plan': '計劃模式', '/compact': '壓縮上下文', '/init': '產生 CLAUDE.md', '/sandbox': '沙箱', '/auto': '自動核准', '/undo': '撤銷', '/tools': '工具', '/memory': '記憶', '/playbook': '專案手冊', '/skills': '技能', '/episodes': '情節', '/trust': '信任', '/sessions': '對話', '/resume': '續接', '/cost': '成本', '/clear': '清除', '/exit': '離開' };

// /init：分析 codebase 產生 CLAUDE.md（走一般回合，用固定指令；對標 Claude Code 的 /init）。
const INIT_PROMPT = '分析這個 codebase 並產生一份 CLAUDE.md 放在專案根目錄（若已存在則就地改進，別覆蓋掉有用內容）。'
  + '先用 ls/glob/grep/read 探索：專案用途、技術棧、目錄結構、建置/測試/執行指令、程式碼慣例與重要架構決策。'
  + '寫成精簡、對「未來接手的 AI agent」實用的指南——只寫專案裡實際存在、查證過的資訊，不要臆造。最後用 write 存成 CLAUDE.md。';

export function runTui({ pack, model, getApiKey, resolveModel, models = [], sandbox = false, resume = null, cwd = process.cwd(), auto = false, extraTools = [], onExit = null }) {
  const store = createStore();
  let history = [];
  let sessionId;
  let currentAgent = null;
  let planMode = false;
  let sandboxOn = !!sandbox;
  let autoApprove = !!auto;
  let pendingSelect = null;
  const sessionTok = { in: 0, out: 0 };
  const turnTok = { in: 0, out: 0 };   // 本輪 token（spinner 即時顯示 + 結束小結）
  let toolStartAt = 0;                  // 單一工具起始時間（算耗時）

  const askConfirm = (name, args, danger) => {
    if (autoApprove && !danger) return Promise.resolve('yes');
    return new Promise((resolve) => {
      const opts = danger ? ['允許一次', '拒絕'] : ['允許', '此工具全部允許', '拒絕'];
      const map = danger ? ['yes', 'no'] : ['yes', 'always', 'no'];
      pendingSelect = { resolve, map };
      store.askSelect(previewChange(name, args) + (danger ? R(`⛔ 危險：${danger}\n`) : '') + Y(`允許 ${name}`) + G(`(${summarize(args)})`), opts);
    });
  };

  const kernel = createKernel(pack, {
    model, getApiKey, resolveModel, extraTools,
    sandbox: { enabled: sandboxOn }, getSandbox: () => sandboxOn,
    getPlanMode: () => planMode, confirm: askConfirm,
  });
  sessionId = kernel.session.newId();
  if (resume) {
    const data = resume === true ? (kernel.session.latest() && kernel.session.load(kernel.session.latest().id)) : kernel.session.load(resume);
    if (data?.messages?.length) { history = data.messages; sessionId = data.id; }
  }
  const persist = () => { try { kernel.session.save(sessionId, history); } catch { /* 略 */ } };

  // ── kernel 事件 → store ──
  let pendingSummary = '';
  const onEvent = (ev) => {
    switch (ev.type) {
      case 'message_update': {
        const a = ev.assistantMessageEvent;
        if (a?.type === 'text_delta' && a.delta) store.appendLive(a.delta);
        else if (a?.type === 'thinking_delta' && a.delta) store.appendThinking(a.delta);
        break;
      }
      case 'message_end': {
        const u = ev.message?.usage;
        if (u) {
          sessionTok.in += u.input || 0; sessionTok.out += u.output || 0;
          turnTok.in += u.input || 0; turnTok.out += u.output || 0;
          store.set({ turnTok: turnTok.in + turnTok.out });   // spinner 即時 token
          const used = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
          if (used) store.set({ ctx: { used, total: model.contextWindow || 0 } });
        }
        break;
      }
      // 子 agent / 平行 map 的巢狀活動：即時顯示在狀態列（對標 xitto-code 的「⟳ 子agent」；否則 TUI 完全看不到子任務在跑）
      case 'tool_execution_update': {
        const p = ev.partialResult;
        if (p?.kind === 'subagent') store.setStatus(p.phase === 'end' ? '' : C(`⟳ 子agent ${p.name || ''}`) + (p.args ? G(`(${summarize(p.args)})`) : ''));
        else if (p?.kind === 'mapagent') store.setStatus(p.phase === 'item_done' ? '' : C(`⟳ 平行 ${(p.index ?? 0) + 1}/${p.total}`) + (p.task ? G(`(${String(p.task).slice(0, 40)})`) : ''));
        break;
      }
      case 'tool_execution_start':
        store.finalizeLive();
        toolStartAt = Date.now();
        if (ev.toolName === 'todo_write' && Array.isArray(ev.args?.todos)) {
          // 原地更新的待辦面板（非堆疊）：每次 update 在原位重畫
          store.set({ tasks: ev.args.todos.map((t) => '  ' + (t.status === 'completed' ? Gn('☑ ') + G(t.content) : t.status === 'in_progress' ? Y('◐ ') + t.content : G('☐ ' + t.content))).join('\n') });
        } else {
          pendingSummary = summarize(ev.args);
          store.setTool({ name: toolLabel(ev.toolName), summary: pendingSummary });
        }
        break;
      case 'tool_execution_end': {
        store.setTool(null); store.setStatus('');
        const dur = toolStartAt ? ((Date.now() - toolStartAt) / 1000).toFixed(1) + 's' : '';
        if (ev.toolName !== 'todo_write') {
          const d = ev.result?._diff;
          if (d && !ev.isError && (d.added || d.removed || d.tooBig)) {
            store.pushBlock(Y(`⏺ ${toolLabel(ev.toolName)}`) + (pendingSummary ? G(`(${pendingSummary})`) : '') + (dur ? G(` ${dur}`) : '') + '\n' + diffBlock(d));
          } else {
            store.pushBlock(toolResultBlock(ev.toolName, pendingSummary, ev.result, ev.isError, dur));
          }
        }
        pendingSummary = ''; toolStartAt = 0;
        break;
      }
      case 'verify_start': store.finalizeLive(); store.pushBlock(G('  🔎 自動驗收…')); break;
      case 'verify_end': store.pushBlock(ev.ok ? G('  ✓ 驗收通過') : Y('  ✗ 驗收失敗，修正中…')); break;
      case 'compact': store.pushBlock(G(`  ⊙ 已壓縮上下文：${ev.tokensBefore}→${ev.tokensAfter} tokens`)); break;
      case 'hook_fail': store.pushBlock(Y(`  ✗ hook 失敗 ${ev.command}`)); break;
      case 'agent_end': store.finalizeLive(); break;
    }
  };

  // ── @檔案展開 ──
  const expandMentions = (text) => text.replace(/(^|\s)@(\S+)/g, (m, sp, p) => {
    const fp = isAbsolute(p) ? p : join(cwd, p);
    if (existsSync(fp)) { try { return `${sp}${p}\n\n<file path="${p}">\n${readFileSync(fp, 'utf8').slice(0, 8000)}\n</file>`; } catch { return m; } }
    return m;
  });

  const refreshGit = () => {
    try { const b = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); const dirty = execSync('git status --short', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); store.set({ gitLabel: b ? `⎇ ${b}${dirty ? ' ✱' : ''}` : '' }); } catch { store.set({ gitLabel: '' }); }
  };
  const setStatus = () => { store.set({ modelLabel: model.id, cwdLabel: cwd.replace(homedir(), '~'), sandboxLabel: sandboxOn ? '🔒 sandbox' : '', permLabel: autoApprove ? '⚡ auto' : '' }); store.setPlan(planMode); refreshGit(); };

  const cmdHistory = [];
  let ink;
  let resizeTimer = null;
  // 終端 resize：Ink 的增量清行以「換行數」而非實際終端列數計算，視窗變窄會誤算、殘留亂碼。
  // 對策（對標 Claude Code）：debounce 後全清螢幕 + 卸載重掛 → <Static> 依新寬度整份重印、
  // 動態區從頭重繪。store 保有完整 transcript，故重掛不丟歷史（僅輸入框當下未送出的字會清掉）。
  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try { ink?.unmount(); } catch { /* 略 */ }
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      ink = mountTui({ store, handlers });
    }, 120);
  };
  const doExit = () => { persist(); if (resizeTimer) clearTimeout(resizeTimer); try { process.stdout.off('resize', onResize); } catch { /* 略 */ } try { if (onExit) onExit(); } catch { /* 略 */ } try { ink?.unmount(); } catch { /* 略 */ } process.exit(0); };

  // ── 斜線指令 ──
  const slash = (input) => {
    const [cmd, arg] = input.split(/\s+/);
    const rest = input.slice(cmd.length).trim(); // 子命令/查詢（可含空白），供 /playbook forget、/episodes <詞> 等
    switch (cmd) {
      case '/exit': case '/quit': doExit(); return true;
      case '/help': store.pushBlock(G(Object.entries(SLASH).map(([k, v]) => `  ${k}  ${v}`).join('\n') + '\n  @檔案 引用 · !命令 直接跑 · #文字 存記憶')); return true;
      case '/model': {
        if (!arg) {
          const lines = (models || []).map((m) => `  ${m.id === model.id ? Gn('●') : ' '} ${m.id}${m.name && m.name !== m.id ? G('  ' + m.name) : ''}${G('  · ' + m.provider)}`);
          store.pushBlock(G('目前：') + Gn(model.id) + '\n' + (lines.length ? lines.join('\n') : G('（providers.json 沒有其他 model）')) + '\n' + G('用 /model <id> 切換'));
          return true;
        }
        const m = resolveModel ? resolveModel(arg) : null;
        if (!m) { store.pushBlock(R(`找不到 model「${arg}」（打 /model 看清單）`)); return true; }
        model = m; kernel.setModel(m); setStatus();
        store.pushBlock(Gn(`✓ 已切換 model：${m.id}`) + G('（下一輪生效）'));
        return true;
      }
      case '/sandbox': sandboxOn = arg ? arg === 'on' : !sandboxOn; setStatus(); store.pushBlock(sandboxOn ? Y('🔒 沙箱開') : G('沙箱關')); return true;
      case '/auto': autoApprove = arg ? arg === 'on' : !autoApprove; setStatus(); store.pushBlock(autoApprove ? Y('⚡ 自動核准開') : G('自動核准關')); return true;
      case '/plan': planMode = arg ? arg === 'on' : !planMode; setStatus(); store.pushBlock(planMode ? C('📋 計劃模式開') : G('計劃模式關')); return true;
      case '/undo': { const r = kernel.undo(); store.pushBlock(r.undone ? G(`↩ 已撤銷 ${r.path}`) : Y(r.reason)); return true; }
      case '/tools': store.pushBlock(G(kernel.registry.names().join('  '))); return true;
      case '/memory': { const m = kernel.memory.list(); store.pushBlock(m.length ? G(m.map((x) => '  • ' + x).join('\n')) : G('（尚無記憶）')); return true; }
      case '/playbook': {
        if (rest === 'clear') { const { cleared } = kernel.playbook.clear(); store.pushBlock(G(`（已清空專案手冊，移除 ${cleared} 條）`)); return true; }
        if (rest.startsWith('forget ')) { const t = rest.slice(7).trim(); const r = kernel.playbook.remove(t); store.pushBlock(r.removed ? G(`（已移除「${t}」）`) : Y(`找不到主題「${t}」`)); return true; }
        const entries = kernel.playbook.list();
        store.pushBlock(entries.length ? entries.map((e) => C(`  ## ${e.topic}`) + '\n' + G(e.note.split('\n').map((l) => '  ' + l).join('\n'))).join('\n') + G('\n  ↳ 清除：/playbook forget <主題>') : G('（尚無專案手冊；agent 摸清做法時會用 playbook_update 累積）'));
        return true;
      }
      case '/skills': {
        if (rest.startsWith('forget ')) { const n = rest.slice(7).trim(); const r = kernel.skills.remove(n); store.pushBlock(r.removed ? G(`（已移除技能「${r.removed}」）`) : Y(`找不到技能「${n}」`)); return true; }
        if (rest === 'check') { store.pushBlock(G('複查中（重跑各技能 verify）…')); kernel.skills.check().then((res) => store.pushBlock(res.length ? res.map((r) => (r.status === 'ok' ? Gn('  ✓ ') : r.status === 'stale' ? R('  ✗ ') : G('  - ')) + r.name + G(`（${r.status}）`)).join('\n') : G('（尚無技能可複查）'))); return true; }
        const sk = kernel.skills.list();
        store.pushBlock(sk.length ? sk.map((s) => (s.stale ? R('  ⚠ ') : C('  • ')) + s.name + G(`：${s.desc}${s.used ? ` · 用過 ${s.used} 次` : ''}${s.stale ? ' · 已失效待修' : ''}`)).join('\n') + G('\n  ↳ 複查：/skills check · 移除：/skills forget <名>') : G('（尚無技能；agent 摸出可重複流程時會用 skill_save 結晶）'));
        return true;
      }
      case '/episodes': {
        if (rest === 'clear') { const { cleared } = kernel.episodes.clear(); store.pushBlock(G(`（已清空情節，移除 ${cleared} 筆）`)); return true; }
        if (rest) { const hits = kernel.episodes.recall(rest, 8); store.pushBlock(hits.length ? hits.map((h) => C(`  • [${h.score}] `) + h.summary + G(`${h.outcome ? ` (${h.outcome})` : ''}${h.tags?.length ? ` [${h.tags.join(', ')}]` : ''}`)).join('\n') : G(`（沒召回到與「${rest}」相關的情節）`)); return true; }
        const eps = kernel.episodes.list(15);
        store.pushBlock(eps.length ? eps.map((e) => C('  • ') + e.summary + G(`${e.outcome ? ` (${e.outcome})` : ''}${e.tags?.length ? ` [${e.tags.join(', ')}]` : ''}`)).join('\n') + G(`\n  ↳ ${kernel.episodes.count()} 筆 · 試召回：/episodes <關鍵詞>`) : G('（尚無情節；完成有價值的任務時 agent 會用 episode_record 記下）'));
        return true;
      }
      case '/trust': {
        if (rest === 'clear') { kernel.permissions.clear(); store.pushBlock(G('（已清除全部信任）')); return true; }
        if (rest.startsWith('forget ')) { const entry = rest.slice(7).trim(); store.pushBlock(kernel.permissions.forget(entry) ? G(`（已撤銷信任：${entry}）`) : Y(`找不到信任項「${entry}」`)); return true; }
        const { tools, bash } = kernel.permissions.list();
        if (!tools.length && !bash.length) { store.pushBlock(G('（尚無已信任項；批准工具時選「此工具全部允許」即可記住）')); return true; }
        store.pushBlock((tools.length ? G('  工具（全部放行）：') + tools.join('、') + '\n' : '') + (bash.length ? G('  命令（簽章類）：') + bash.map((s) => `「${s}」`).join('、') : '') + G('\n  ↳ 撤銷：/trust forget <項>'));
        return true;
      }
      case '/cost': store.pushBlock(G(`本 session 累計：${sessionTok.in + sessionTok.out} tokens（in ${sessionTok.in} / out ${sessionTok.out}）`)); return true;
      case '/sessions': { const ss = kernel.session.list(); store.pushBlock(ss.length ? G(ss.map((s) => `  ${s.id}  [${s.count} 則]`).join('\n')) : G('（尚無對話）')); return true; }
      case '/resume': { const t = arg || kernel.session.latest()?.id; const d = t ? kernel.session.load(t) : null; if (d?.messages?.length) { history = d.messages; sessionId = d.id; store.pushBlock(G(`（已續接 ${d.id}，${d.messages.length} 則）`)); } else store.pushBlock(Y('找不到可續接的 session')); return true; }
      case '/clear': history = []; sessionId = kernel.session.newId(); store.pushBlock(G('（已清除歷史，開新 session）')); return true;
      default: store.pushBlock(R(`未知指令 ${cmd}（/help）`)); return true;
    }
  };

  // 每輪開始：歸零本輪 token、清原地待辦面板、進 busy。回傳起始時間戳。
  const beginTurn = () => { turnTok.in = 0; turnTok.out = 0; store.setMode('busy'); store.set({ busyAt: Date.now(), turnTok: 0, tasks: '' }); return Date.now(); };
  // 每輪收尾：凍結待辦面板進歷史 + 印 token/耗時小結（對標 Claude Code 的 ↳ 小結）。
  const finishTurn = (startAt) => {
    const tasks = store.get().tasks;
    if (tasks) { store.pushBlock(C('☑ 待辦') + '\n' + tasks); store.set({ tasks: '' }); }
    const tot = turnTok.in + turnTok.out;
    if (tot) store.pushBlock(G(`  ↳ ${Math.round((Date.now() - startAt) / 1000)}s · ${fmtTok(tot)} tokens（↑${fmtTok(turnTok.in)} ↓${fmtTok(turnTok.out)}）`));
    currentAgent = null; store.setTool(null); store.setStatus(''); store.set({ busyAt: null }); store.setMode('idle'); refreshGit();
  };

  // ── 送出 ──
  async function onSubmit(raw) {
    const input = (raw || '').trim();
    if (!input) return;
    if (store.get().mode === 'busy') { try { currentAgent?.steer({ role: 'user', content: input }); store.pushBlock(G('  ↪ 已插入引導')); } catch { /* 略 */ } return; }
    cmdHistory.push(input);
    store.pushBlock('\n' + input.split('\n').map((l) => `\x1b[34m▌ \x1b[1m${l}\x1b[22m\x1b[39m`).join('\n'));

    if (input.startsWith('/goal ') || input === '/goal') { return runGoal(input.slice(5).trim()); }
    if (input === '/compact') { return runCompact(); }
    if (input === '/init') { return runAgentTurn(INIT_PROMPT); }
    if (input.startsWith('/')) { slash(input); return; }
    if (input.startsWith('!')) { const r = (() => { try { return execSync(input.slice(1), { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return (e.stdout || '') + (e.stderr || '') || e.message; } })(); store.pushBlock(G('$ ' + input.slice(1)) + '\n' + (r.trim() || '(no output)')); return; }
    if (input.startsWith('#')) { const r = kernel.memory.save(input.slice(1).trim()); store.pushBlock(r.saved ? G('✎ 已記住：' + r.saved) : G('（記憶已存在或空）')); return; }

    return runAgentTurn(input);
  }

  // 跑一般 agent 回合（一般輸入與 /init 共用）。planMode 前綴、@檔案展開、保底提示、token 小結。
  async function runAgentTurn(userText) {
    const startAt = beginTurn();
    try {
      const text = expandMentions(planMode ? `[計劃模式：只規劃、列步驟與會改動的檔案，不要實際寫檔或執行命令]\n\n${userText}` : userText);
      const r = await kernel.runTurn(text, { history, onEvent, onAgent: (a) => { currentAgent = a; } });
      store.finalizeLive(); history = r.messages; persist();
      const note = turnNotice(r.stopReason, !!r.text); // 保底：截斷/空回應也給一句話，不留半截或空白
      if (note) store.pushBlock(Y(note));
    } catch (e) { store.finalizeLive(); store.pushBlock(R('錯誤：' + e.message)); }
    finally { finishTurn(startAt); }
  }

  // /compact：手動壓縮歷史（對標 Claude Code）。不看閾值，摘要較舊對話、保留最近數輪。
  async function runCompact() {
    if (store.get().mode === 'busy') return;
    if (history.length < 2) { store.pushBlock(G('（沒有足夠的歷史可壓縮）')); return; }
    store.setMode('busy'); store.set({ busyAt: Date.now(), turnTok: 0 });
    store.pushBlock(G('  ⊙ 壓縮上下文中…'));
    try {
      const r = await kernel.compact(history);
      if (!r || r.error || !r.messages) { store.pushBlock(Y(r?.error === 'nothing-to-compact' ? '（沒有可壓縮的較舊對話）' : '壓縮失敗（稍後再試）')); }
      else {
        history = r.messages; persist();
        const i = r.info;
        store.pushBlock(G(`  ⊙ 已壓縮：${i.tokensBefore}→${i.tokensAfter} tokens（摘要 ${i.summarized} 則、保留 ${i.kept} 則）`));
        store.set({ ctx: { used: i.tokensAfter, total: model.contextWindow || 0 } });
      }
    } catch (e) { store.pushBlock(R('壓縮錯誤：' + e.message)); }
    finally { store.set({ busyAt: null }); store.setMode('idle'); refreshGit(); }
  }

  async function runGoal(goal) {
    if (!goal) { store.pushBlock(G('用法 /goal <目標>')); return; }
    store.pushBlock(C('🎯 目標：') + goal);
    const startAt = beginTurn();
    try {
      const r = await kernel.runGoal(goal, {
        history,
        onRound: ({ round, maxRounds }) => { store.finalizeLive(); store.pushBlock(Y(`🔁 第 ${round}/${maxRounds} 輪`)); },
        onCheck: ({ done, remaining }) => { store.finalizeLive(); store.pushBlock(done ? G('  ✓ 驗收：已達成') : G('  ↻ ' + remaining)); },
        onEvent, onAgent: (a) => { currentAgent = a; },
      });
      store.finalizeLive(); history = r.history; persist();
      store.pushBlock(r.done ? G(`✅ 目標達成（${r.rounds} 輪）`) : Y(`⚠ 未達成（${r.rounds} 輪）`));
    } catch (e) { store.finalizeLive(); store.pushBlock(R('錯誤：' + e.message)); }
    finally { finishTurn(startAt); }
  }

  // ── 補全（斜線 + @檔案）──
  // 多層聯動：指令 → 參數 → 子項（如 /skills → forget → <技能名>）。
  // 帶 sub 的選項 value 以空白結尾 → 接受後游標落在其後，自動彈出下一層。
  const HAS_ARGS = new Set(['/model', '/sandbox', '/auto', '/plan', '/resume', '/skills', '/playbook', '/trust', '/episodes']);
  const cmdArgs = (cmd) => {
    switch (cmd) {
      case '/model': return (models || []).map((m) => ({ value: m.id, desc: m.provider }));
      case '/sandbox': case '/auto': case '/plan': return [{ value: 'on' }, { value: 'off' }];
      case '/resume': return kernel.session.list().map((s) => ({ value: s.id, desc: `${s.count} 則` }));
      case '/episodes': return [{ value: 'clear', desc: '清空' }];
      case '/skills': return [{ value: 'check', desc: '複查失效' }, { value: 'forget ', desc: '移除 <技能名>', sub: () => kernel.skills.list().map((s) => ({ value: s.name, desc: s.desc })) }];
      case '/playbook': return [{ value: 'clear', desc: '清空' }, { value: 'forget ', desc: '移除 <主題>', sub: () => kernel.playbook.list().map((e) => ({ value: e.topic })) }];
      case '/trust': return [{ value: 'clear', desc: '清除全部' }, { value: 'forget ', desc: '撤銷 <項>', sub: () => { const { tools, bash } = kernel.permissions.list(); return [...tools, ...bash].map((v) => ({ value: String(v) })); } }];
      default: return null;
    }
  };
  const complete = (text) => {
    // 斜線指令三層聯動（純函數）
    const sc = slashComplete(text, { slashMap: SLASH, hasArgs: HAS_ARGS, argsFor: cmdArgs });
    if (sc) return sc;
    // @檔案路徑補全
    const am = text.match(/(?:^|\s)@(\S*)$/);
    if (am) {
      const frag = am[1]; const at = text.length - frag.length - 1; const slashI = frag.lastIndexOf('/');
      const dir = slashI >= 0 ? frag.slice(0, slashI + 1) : ''; const base = slashI >= 0 ? frag.slice(slashI + 1) : frag;
      let entries; try { entries = readdirSync(join(cwd, dir), { withFileTypes: true }); } catch { return null; }
      const items = entries.filter((e) => e.name.startsWith(base) && !e.name.startsWith('.')).slice(0, 8).map((e) => '@' + dir + e.name + (e.isDirectory() ? '/' : ''));
      return items.length ? { start: at, items } : null;
    }
    return null;
  };

  const abort = () => { try { currentAgent?.abort(); } catch { /* 略 */ } if (pendingSelect) { const p = pendingSelect; pendingSelect = null; store.clearSelect(); p.resolve('no'); } store.finalizeLive(); store.setTool(null); store.set({ busyAt: null }); store.setMode('idle'); };
  let lastCtrlC = 0;
  const handlers = {
    onSubmit,
    onCtrlC: () => { if (store.get().mode === 'busy') { abort(); store.pushBlock(Y('⏹ 已中斷')); return; } const now = Date.now(); if (now - lastCtrlC < 2000) doExit(); else { lastCtrlC = now; store.pushBlock(G('再按一次 Ctrl+C 離開')); } },
    onEscape: () => { if (store.get().mode === 'busy') { abort(); store.pushBlock(Y('⏹ 已中斷')); } },
    getHistory: () => cmdHistory,
    complete,
    onSelectChoice: (idx) => { const p = pendingSelect; pendingSelect = null; store.clearSelect(); if (p) p.resolve(p.map[idx] ?? 'no'); },
    onSelectCancel: () => { const p = pendingSelect; pendingSelect = null; store.clearSelect(); if (p) p.resolve('no'); },
    onSelectAbort: () => { abort(); },
  };

  // 橫幅 + 狀態列
  store.pushBlock('\n' + C('✻ ') + '\x1b[1mxitto-kernel\x1b[22m' + G(`  ·  ${pack.name} pack  ·  ${model.id}`) + '\n' + G('  Esc 中斷 · /help · @檔案 · !命令 · #記憶 · Tab 補全'));
  setStatus();
  store.setMode('idle'); store.setPlaceholder('輸入訊息…');
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  ink = mountTui({ store, handlers });
  try { process.stdout.on('resize', onResize); } catch { /* 非 TTY：無 resize 事件 */ }
  return ink;
}
