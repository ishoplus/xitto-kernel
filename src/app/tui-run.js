// Ink TUI driver — 把 kernel 接上 tui.js 的 store/handlers/App（對標 Claude Code 的全 TUI 體驗）。
// 常駐狀態列、串流即時重繪、Esc 中斷、權限 Select、@檔案/!bash/#記憶/斜線指令。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createKernel } from '../kernel/index.js';
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

// 工具卡（對標 Claude Code）：⏺ name(args) 標頭 + ⎿ 多行結果,過長摺疊成「… +N 行」。純函數,可測。
export function toolBlock(name, summary, result, isError) {
  const head = Y(`⏺ ${name}`) + (summary ? G(`(${summary})`) : '');
  const raw = (result?.content || []).map((c) => c.text || '').join('\n').replace(/\s+$/, '');
  if (!raw.trim()) return head + '\n' + (isError ? R('  ⎿ ✗') : Gn('  ⎿ ✓'));
  const lines = raw.split('\n');
  const MAX = isError ? 12 : 6;
  const shown = lines.slice(0, MAX).map((l, i) => '  ' + (i === 0 ? '⎿ ' : '  ') + l.slice(0, 200));
  let out = head + '\n' + (isError ? R : G)(shown.join('\n'));
  if (lines.length > MAX) out += '\n' + G(`     … +${lines.length - MAX} 行`);
  return out;
}

// 彩色 diff 區塊（綠 + / 紅 -）：渲染 kernel 掛在 result._diff 的行級 diff。
export function diffBlock(d) {
  if (!d) return '';
  const head = G('  ⎿ ') + Gn(`+${d.added}`) + ' ' + R(`-${d.removed}`) + G(' 行');
  if (d.tooBig) return head + G('（差異過大,省略內容）');
  const changed = (d.lines || []).filter((l) => l.t !== ' ');
  if (!changed.length) return '';
  const MAX = 30;
  const body = changed.slice(0, MAX).map((l) => (l.t === '+' ? Gn('    + ' + l.s.slice(0, 200)) : R('    - ' + l.s.slice(0, 200)))).join('\n');
  return head + '\n' + body + (changed.length > MAX ? '\n' + G(`     … +${changed.length - MAX} 行變更`) : '');
}

const SLASH = { '/help': '說明', '/goal': '目標循環', '/sandbox': '沙箱', '/auto': '自動核准', '/plan': '計劃模式', '/undo': '撤銷', '/tools': '工具', '/memory': '記憶', '/sessions': '對話', '/resume': '續接', '/cost': '成本', '/clear': '清除', '/exit': '離開' };

export function runTui({ pack, model, getApiKey, sandbox = false, resume = null, cwd = process.cwd() }) {
  const store = createStore();
  let history = [];
  let sessionId;
  let currentAgent = null;
  let planMode = false;
  let sandboxOn = !!sandbox;
  let autoApprove = false;
  let pendingSelect = null;
  const sessionTok = { in: 0, out: 0 };

  const askConfirm = (name, args, danger) => {
    if (autoApprove && !danger) return Promise.resolve('yes');
    return new Promise((resolve) => {
      const opts = danger ? ['允許一次', '拒絕'] : ['允許', '此工具全部允許', '拒絕'];
      const map = danger ? ['yes', 'no'] : ['yes', 'always', 'no'];
      pendingSelect = { resolve, map };
      store.askSelect((danger ? R(`⛔ 危險：${danger}\n`) : '') + Y(`允許 ${name}`) + G(`(${summarize(args)})`), opts);
    });
  };

  const kernel = createKernel(pack, {
    model, getApiKey,
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
        if (u) { sessionTok.in += u.input || 0; sessionTok.out += u.output || 0; const used = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0); if (used) store.set({ ctx: { used, total: model.contextWindow || 0 } }); }
        break;
      }
      case 'tool_execution_start':
        store.finalizeLive();
        if (ev.toolName === 'todo_write' && Array.isArray(ev.args?.todos)) {
          store.pushBlock(C('☑ 待辦') + '\n' + ev.args.todos.map((t) => '  ' + (t.status === 'completed' ? Gn('☑ ') + G(t.content) : t.status === 'in_progress' ? Y('◐ ') + t.content : G('☐ ' + t.content))).join('\n'));
        } else {
          pendingSummary = summarize(ev.args);
          store.setTool({ name: ev.toolName, summary: pendingSummary });
        }
        break;
      case 'tool_execution_end': {
        store.setTool(null);
        if (ev.toolName !== 'todo_write') {
          const d = ev.result?._diff;
          if (d && !ev.isError && (d.added || d.removed || d.tooBig)) {
            store.pushBlock(Y(`⏺ ${ev.toolName}`) + (pendingSummary ? G(`(${pendingSummary})`) : '') + '\n' + diffBlock(d));
          } else {
            store.pushBlock(toolBlock(ev.toolName, pendingSummary, ev.result, ev.isError));
          }
        }
        pendingSummary = '';
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
  const doExit = () => { persist(); try { ink?.unmount(); } catch { /* 略 */ } process.exit(0); };

  // ── 斜線指令 ──
  const slash = (input) => {
    const [cmd, arg] = input.split(/\s+/);
    switch (cmd) {
      case '/exit': case '/quit': doExit(); return true;
      case '/help': store.pushBlock(G(Object.entries(SLASH).map(([k, v]) => `  ${k}  ${v}`).join('\n') + '\n  @檔案 引用 · !命令 直接跑 · #文字 存記憶')); return true;
      case '/sandbox': sandboxOn = arg ? arg === 'on' : !sandboxOn; setStatus(); store.pushBlock(sandboxOn ? Y('🔒 沙箱開') : G('沙箱關')); return true;
      case '/auto': autoApprove = arg ? arg === 'on' : !autoApprove; setStatus(); store.pushBlock(autoApprove ? Y('⚡ 自動核准開') : G('自動核准關')); return true;
      case '/plan': planMode = arg ? arg === 'on' : !planMode; setStatus(); store.pushBlock(planMode ? C('📋 計劃模式開') : G('計劃模式關')); return true;
      case '/undo': { const r = kernel.undo(); store.pushBlock(r.undone ? G(`↩ 已撤銷 ${r.path}`) : Y(r.reason)); return true; }
      case '/tools': store.pushBlock(G(kernel.registry.names().join('  '))); return true;
      case '/memory': { const m = kernel.memory.list(); store.pushBlock(m.length ? G(m.map((x) => '  • ' + x).join('\n')) : G('（尚無記憶）')); return true; }
      case '/cost': store.pushBlock(G(`本 session 累計：${sessionTok.in + sessionTok.out} tokens（in ${sessionTok.in} / out ${sessionTok.out}）`)); return true;
      case '/sessions': { const ss = kernel.session.list(); store.pushBlock(ss.length ? G(ss.map((s) => `  ${s.id}  [${s.count} 則]`).join('\n')) : G('（尚無對話）')); return true; }
      case '/resume': { const t = arg || kernel.session.latest()?.id; const d = t ? kernel.session.load(t) : null; if (d?.messages?.length) { history = d.messages; sessionId = d.id; store.pushBlock(G(`（已續接 ${d.id}，${d.messages.length} 則）`)); } else store.pushBlock(Y('找不到可續接的 session')); return true; }
      case '/clear': history = []; sessionId = kernel.session.newId(); store.pushBlock(G('（已清除歷史，開新 session）')); return true;
      default: store.pushBlock(R(`未知指令 ${cmd}（/help）`)); return true;
    }
  };

  // ── 送出 ──
  async function onSubmit(raw) {
    const input = (raw || '').trim();
    if (!input) return;
    if (store.get().mode === 'busy') { try { currentAgent?.steer({ role: 'user', content: input }); store.pushBlock(G('  ↪ 已插入引導')); } catch { /* 略 */ } return; }
    cmdHistory.push(input);
    store.pushBlock('\n' + input.split('\n').map((l) => `\x1b[34m▌ \x1b[1m${l}\x1b[22m\x1b[39m`).join('\n'));

    if (input.startsWith('/goal ') || input === '/goal') { return runGoal(input.slice(5).trim()); }
    if (input.startsWith('/')) { slash(input); return; }
    if (input.startsWith('!')) { const r = (() => { try { return execSync(input.slice(1), { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return (e.stdout || '') + (e.stderr || '') || e.message; } })(); store.pushBlock(G('$ ' + input.slice(1)) + '\n' + (r.trim() || '(no output)')); return; }
    if (input.startsWith('#')) { const r = kernel.memory.save(input.slice(1).trim()); store.pushBlock(r.saved ? G('✎ 已記住：' + r.saved) : G('（記憶已存在或空）')); return; }

    store.setMode('busy'); store.set({ busyAt: Date.now() });
    try {
      const text = expandMentions(planMode ? `[計劃模式：只規劃、列步驟與會改動的檔案，不要實際寫檔或執行命令]\n\n${input}` : input);
      const r = await kernel.runTurn(text, { history, onEvent, onAgent: (a) => { currentAgent = a; } });
      store.finalizeLive(); history = r.messages; persist();
    } catch (e) { store.finalizeLive(); store.pushBlock(R('錯誤：' + e.message)); }
    finally { currentAgent = null; store.setTool(null); store.set({ busyAt: null }); store.setMode('idle'); refreshGit(); }
  }

  async function runGoal(goal) {
    if (!goal) { store.pushBlock(G('用法 /goal <目標>')); return; }
    store.pushBlock(C('🎯 目標：') + goal);
    store.setMode('busy'); store.set({ busyAt: Date.now() });
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
    finally { currentAgent = null; store.setTool(null); store.set({ busyAt: null }); store.setMode('idle'); refreshGit(); }
  }

  // ── 補全（斜線 + @檔案）──
  const complete = (text) => {
    const sm = text.match(/^\/(\S*)$/);
    if (sm) { const items = Object.keys(SLASH).filter((c) => c.startsWith('/' + sm[1])).map((c) => ({ value: c, desc: SLASH[c] })); return items.length ? { start: 0, items } : null; }
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
  return ink;
}
