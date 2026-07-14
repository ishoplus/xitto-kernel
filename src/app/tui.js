// Ink（終端版 React）渲染層 — 對標 Claude Code：
//   1) 已完成訊息進 <Static>：打一次、不重繪、隨終端捲動。
//   2) 串流中的回覆：已完成的「段落」即時 render markdown 提交進 <Static>（見 appendLive），
//      動態區只保留「正在輸入的最後一段」並每幀重解析重繪——動態區恆小，避免回覆變長後
//      動態區高度 ≥ 終端列數而退回 Ink 全螢幕重繪慢路徑（閃爍根因）。
//   3) 自訂 Input：命令歷史(↑↓)、斜線/@補全(Tab)、多行(反斜線續行/貼上)、游標編輯。
//   4) 輸入框永遠在最底，上方依序為輸出 / spinner / 頁腳 / 狀態列。
import React, { useState, useEffect } from 'react';
import { render, Box, Text, Static, useInput } from 'ink';
import { md, lexBlocks, codeChunk } from './md-render.js';

const h = React.createElement;
const DOT = '\x1b[32m⏺\x1b[39m'; // 綠色實心圓，標記回覆/工具（對標 Claude Code）
// 左側溝槽：第一行加 head 前綴（為 '' 時與其餘行一樣縮排 2 空格，用於「延續區塊」），
// 讓整段成為一個視覺區塊。延續區塊不再重複 ● 標記。
export function gutter(text, head = DOT) {
  const pad = head ? head + ' ' : '  ';
  return text.split('\n').map((l, i) => (i === 0 ? pad + l : '  ' + l)).join('\n');
}

// 串流增量提交（對標 Claude Code）：用 markdown 的 block lexer 把 live 切成頂層區塊，
// 提交「除最後一塊外」的完整區塊進 <Static>，最後一塊（可能還沒打完）留在動態區。
// 例外：最後一塊是「未閉合且超長的程式碼框」時，逐行提交已完成的程式碼行（見 store.appendLive）。

// live 是否為一個「未閉合的 fenced code block」；是則回 {lang, body}（body 為開頭 fence 之後的程式碼）。
// 容忍開頭的區塊間空行（前一塊提交後 raw 常殘留前導 \n）。
function openCodeBlock(text) {
  const t = text.replace(/^\n+/, '');
  const m = t.match(/^```([^\n]*)\n/);
  if (!m) return null;
  if ((t.match(/```/g) || []).length !== 1) return null; // 只有開頭那組 ``` = 未閉合
  return { lang: m[1].trim(), body: t.slice(m[0].length) };
}
// 超長程式碼框逐行提交的行數門檻：接近一屏才啟動（小/中型 code 仍正常即時渲染、含標頭）。
function codeFlushLines() {
  return Math.max(12, (process.stdout?.rows || 24) - 8);
}
const INV = '\x1b[7m';
const INVOFF = '\x1b[27m';
const GRAY = (s) => `\x1b[90m${s}\x1b[39m`;
const fmtTok = (n) => (n < 1000 ? String(n) : (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k');
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function waitingVerb(sec) {
  if (sec < 3) return '思考中';
  if (sec < 10) return '處理中';
  if (sec < 30) return '仍在處理';
  return '長任務處理中';
}

// 外部 store：plain object + listeners。main() 推狀態，元件 subscribe 後 re-render。
export function createStore(initial = {}) {
  let state = {
    transcript: [], live: '', liveStarted: false, liveCodeLang: null, outputting: false, thinking: '', tool: null, status: '',
    tasks: '',               // 任務面板：活動區就地更新（不進 Static，避免每步更新堆重複列表）
    mode: 'idle', planMode: false, permission: null, placeholder: '',
    busyAt: null,            // 本輪開始時間戳（ms）：思考動畫 + 耗時
    modelLabel: '', cwdLabel: '', gitLabel: '', permLabel: '', sandboxLabel: '', // 狀態列：模型/目錄/git/權限模式/沙箱
    ctx: null,               // {used,total} 上下文用量
    atStart: true,           // 起始乾淨畫面：把輸入框推到終端底部，首次送出後關閉
    suggestions: [],         // 後續追問建議（ghost text + Tab 接受）
    selection: null,         // {title, options} 方向鍵選單（權限確認 / ask_user）
    ask: null,               // {prompt} 純文字問答輸入（ask_user 的「其他（自行輸入）」）
    ...initial,
  };
  const listeners = new Set();
  let id = 1;
  let liveStarted = false; // 本段文字是否已輸出過 ● 開頭（首塊帶 ●，段內後續塊為延續、不重複 ●）
  let codeLang = null;     // 非 null＝正在「逐行提交」一個超長未閉合程式碼框；此時 state.live 只存程式碼本體（無 fence）
  let scheduled = null;
  const emitNow = () => { scheduled = null; for (const l of listeners) l(); };
  const emitThrottled = () => { if (!scheduled) scheduled = setTimeout(emitNow, 40); };

  // 提交一個已完成區塊進 <Static>：rendered 為已渲染好的 ANSI 字串。首塊帶 ●，之後為延續。
  const commitBlock = (rendered) => {
    if (!rendered || !rendered.trim()) return;
    const block = '\n' + gutter(rendered, liveStarted ? '' : DOT);
    liveStarted = true;
    state = { ...state, liveStarted: true, transcript: [...state.transcript, { id: id++, text: block }] };
  };

  return {
    get: () => state,
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    set(p) { state = { ...state, ...p }; emitNow(); },
    pushBlock(text) {
      if (text == null || text === '') return;
      state = { ...state, transcript: [...state.transcript, { id: id++, text }] };
      emitNow();
    },
    appendLive(s) {
      // 一旦開始吐字，整段輸出期間維持「輸出中」旗標——即使區塊提交後 live 短暫變空，
      // 也不會讓狀態列閃回「思考中」（後續 state 均以 {...state} 展開，旗標自動沿用）。
      if (!state.outputting) state = { ...state, outputting: true };
      // --- 模式 A：正在逐行提交超長未閉合程式碼框（state.live 只存程式碼本體、無 fence）---
      if (codeLang != null) {
        let body = state.live + s;
        const close = body.indexOf('```'); // 收尾 fence 到了？
        if (close !== -1) {
          const done = body.slice(0, close).replace(/\n$/, '');
          if (done) commitBlock(codeChunk(done, codeLang, false));
          codeLang = null;
          // 收尾 fence 之後的剩餘文字（去掉 fence 本身與其後換行）回到一般模式，留待下次 delta / finalize 處理
          const rest = body.slice(close + 3).replace(/^[^\n]*\n?/, '');
          state = { ...state, live: rest, liveCodeLang: null };
          emitThrottled();
          return;
        }
        const lines = body.split('\n');
        if (lines.length > codeFlushLines()) {
          commitBlock(codeChunk(lines.slice(0, -1).join('\n'), codeLang, false)); // 提交已完成行、留最後一行（可能未打完）
          body = lines[lines.length - 1];
        }
        state = { ...state, live: body, liveCodeLang: codeLang };
        emitThrottled();
        return;
      }

      // --- 模式 B：一般 markdown。用 block lexer 切塊，提交除最後一塊外的所有完整區塊 ---
      let raw = state.live + s;
      const tokens = lexBlocks(raw);
      if (tokens.length >= 2) {
        let committedRaw = '';
        for (let i = 0; i < tokens.length - 1; i++) committedRaw += tokens[i].raw;
        if (committedRaw.trim() && raw.startsWith(committedRaw)) {
          commitBlock(md(committedRaw));
          raw = raw.slice(committedRaw.length);
        }
      }
      // 最後一塊若是「未閉合且超長」的程式碼框 → 進入模式 A，立即提交首批已完成行（含標頭）
      const open = openCodeBlock(raw);
      if (open && open.body.split('\n').length > codeFlushLines()) {
        codeLang = open.lang;
        const lines = open.body.split('\n');
        commitBlock(codeChunk(lines.slice(0, -1).join('\n'), codeLang, true)); // 首塊含 ┌─ lang 標頭
        state = { ...state, live: lines[lines.length - 1], liveStarted, liveCodeLang: codeLang };
        emitThrottled();
        return;
      }
      state = { ...state, live: raw, liveStarted };
      emitThrottled();
    },
    appendThinking(s) { state = { ...state, thinking: state.thinking + s }; emitThrottled(); },
    finalizeLive() {
      const live = state.live;
      const started = liveStarted;
      const cl = codeLang;
      liveStarted = false; codeLang = null;
      state = { ...state, live: '', liveStarted: false, liveCodeLang: null, outputting: false, thinking: '' };
      if (live.trim()) {
        const rendered = cl != null ? codeChunk(live, cl, false) : md(live);
        state.transcript = [...state.transcript, { id: id++, text: '\n' + gutter(rendered, started ? '' : DOT) }];
      }
      emitNow();
    },
    setTool(tool) { state = { ...state, tool }; emitNow(); },
    setStatus(status) { state = { ...state, status }; emitNow(); },
    setMode(mode) { state = { ...state, mode }; emitNow(); },
    setPlan(planMode) { state = { ...state, planMode }; emitNow(); },
    setPlaceholder(placeholder) { state = { ...state, placeholder }; emitNow(); },
    askSelect(title, options) { state = { ...state, mode: 'select', selection: { title, options } }; emitNow(); },
    clearSelect() { state = { ...state, mode: 'busy', selection: null }; emitNow(); },
    askInput(prompt) { state = { ...state, mode: 'ask', ask: { prompt } }; emitNow(); },
    clearAsk() { state = { ...state, mode: 'busy', ask: null }; emitNow(); },
  };
}

// 通用方向鍵選單（↑↓ / Enter 選、Esc 取消當前提示、Ctrl+C 中斷整輪、數字鍵快選）。
// onCancel：取消這一次選擇（如權限確認＝拒絕該工具）；onAbort：中斷整個回合（Ctrl+C）。
const optLabel = (o) => (typeof o === 'string' ? o : (o?.label ?? String(o)));
export function Select({ title, options, onSelect, onCancel, onAbort }) {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { (onAbort || onCancel)(); return; } // Ctrl+C → 中斷整輪
    if (key.escape) { onCancel(); return; }                              // Esc → 僅取消這次（拒絕該工具）
    if (key.upArrow) { setIndex((i) => (i - 1 + options.length) % options.length); return; }
    if (key.downArrow) { setIndex((i) => (i + 1) % options.length); return; }
    if (key.return) { onSelect(index); return; }
    const n = parseInt(input, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= options.length) { onSelect(n - 1); return; }
  });
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, marginTop: 1 },
    title ? h(Text, null, title) : null,
    ...options.map((o, i) => h(Text, { key: i, color: i === index ? 'cyan' : 'gray' }, `${i === index ? '❯' : ' '} ${i + 1}. ${optLabel(o)}`)),
    h(Text, { color: 'gray' }, '  ↑↓ 選擇 · Enter 確認 · Esc 取消此項 · Ctrl+C 中斷整輪'),
  );
}

// 多行 value + 游標（游標處反白）渲染成字串；空值顯示 ghost/placeholder
function renderValue(value, cursor, hint) {
  if (!value) return INV + ' ' + INVOFF + GRAY(hint || '');
  const at = value.slice(cursor, cursor + 1) || ' ';
  return value.slice(0, cursor) + INV + at + INVOFF + value.slice(cursor + 1);
}

// 貼上折疊占位符的「結尾」樣式（退格時用來判斷游標是否落在占位符末端）
const PASTE_TOKEN_END = /⟦貼上#\d+·\d+行⟧$/;

// 退格邏輯：若游標正好在貼上占位符的結尾，原子刪除整個占位符(連同它代表的內容會在送出時
// 一併消失)；否則刪一個字元。避免退格只刪掉 ⟧ 破壞占位符→送出殘缺字面、貼上內容靜默遺失。
// 純函數，便於單測。回傳 { value, cursor }。
export function backspaceAt(value, cursor) {
  if (cursor <= 0) return { value, cursor };
  const m = value.slice(0, cursor).match(PASTE_TOKEN_END);
  if (m) {
    const start = cursor - m[0].length;
    return { value: value.slice(0, start) + value.slice(cursor), cursor: start };
  }
  return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
}

// 自訂輸入編輯器（取代 ink-text-input，以支援歷史/補全/多行）
function Input({ onSubmit, onCtrlC, onEscape, getHistory, complete, placeholder, promptPrefix, promptColor, suggestions }) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState(null);   // {items, index, start}
  const [histIdx, setHistIdx] = useState(-1);
  const [draft, setDraft] = useState('');
  const [pastes, setPastes] = useState([]); // 多行貼上折疊：value 內放占位符，送出時展開
  // ghost 建議：輸入框為空且有建議時，淡色顯示第一條，Tab 接受
  const ghost = (!value && suggestions && suggestions.length) ? suggestions[0] : '';
  const expandPastes = (v) => v.replace(/⟦貼上#(\d+)·\d+行⟧/g, (m, n) => pastes[Number(n) - 1] ?? m);
  // 依目前輸入自動更新補全選單（邊打邊彈，對標 Claude Code）。
  // 已是完整唯一匹配（如打完 /help）則不彈，避免接受後又跳出來。
  const refresh = (v, cur) => {
    const res = complete ? complete(v.slice(0, cur)) : null;
    if (!res || !res.items.length) { setMenu(null); return; }
    const token = v.slice(res.start, cur);
    if (res.items.length === 1 && res.items[0] === token) { setMenu(null); return; }
    setMenu({ items: res.items, index: 0, start: res.start });
  };
  const put = (v, c) => { const cc = c == null ? v.length : c; setValue(v); setCursor(cc); };
  const edit = (v, c) => { put(v, c); refresh(v, c == null ? v.length : c); }; // 編輯內容並刷新補全

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { onCtrlC(); return; }
    if (key.escape) { if (menu) { setMenu(null); return; } onEscape(); return; }

    if (menu) { // 補全選單導航（開啟時 ↑↓ 走選單、Tab/Enter 接受）
      if (key.upArrow) { setMenu({ ...menu, index: (menu.index - 1 + menu.items.length) % menu.items.length }); return; }
      if (key.downArrow) { setMenu({ ...menu, index: (menu.index + 1) % menu.items.length }); return; }
      if (key.tab || key.return) { const pick = menu.items[menu.index]; edit(value.slice(0, menu.start) + (typeof pick === 'string' ? pick : pick.value)); return; }
      // 其他鍵：先關選單，落到下面照常處理（並會在編輯後重新刷新）
      setMenu(null);
    }

    if (key.tab && ghost) { edit(ghost, ghost.length); return; } // Tab 接受 ghost 建議
    if (key.tab) { refresh(value, cursor); return; } // 選單未開時 Tab 也可手動觸發
    if (key.return) {
      // Shift+Enter / Option(Alt)+Enter → 在游標處換行（多行輸入），不送出
      if (key.shift || key.meta) { edit(value.slice(0, cursor) + '\n' + value.slice(cursor), cursor + 1); return; }
      if (value.endsWith('\\')) { edit(value.slice(0, -1) + '\n'); return; } // 反斜線續行
      const v = expandPastes(value); // 送出前把貼上占位符還原成原文
      setValue(''); setCursor(0); setMenu(null); setHistIdx(-1); setDraft(''); setPastes([]);
      onSubmit(v); return;
    }
    if (key.upArrow) {
      const hist = getHistory(); if (!hist.length) return;
      let i = histIdx; if (i === -1) { setDraft(value); i = 0; } else if (i < hist.length - 1) i++;
      setHistIdx(i); put(hist[hist.length - 1 - i]); return;
    }
    if (key.downArrow) {
      if (histIdx === -1) return;
      const hist = getHistory(); const i = histIdx - 1;
      if (i < 0) { setHistIdx(-1); put(draft); return; }
      setHistIdx(i); put(hist[hist.length - 1 - i]); return;
    }
    // Alt/Option + ←/→：以「詞」為單位移動游標
    if (key.meta && key.leftArrow) { let i = cursor; while (i > 0 && /\s/.test(value[i - 1])) i--; while (i > 0 && !/\s/.test(value[i - 1])) i--; setCursor(i); return; }
    if (key.meta && key.rightArrow) { let i = cursor; while (i < value.length && /\s/.test(value[i])) i++; while (i < value.length && !/\s/.test(value[i])) i++; setCursor(i); return; }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(value.length, cursor + 1)); return; }
    if (key.ctrl && input === 'a') { setCursor(0); return; }
    if (key.ctrl && input === 'e') { setCursor(value.length); return; }
    if (key.ctrl && input === 'u') { edit(value.slice(cursor), 0); return; }            // 刪到行首
    if (key.ctrl && input === 'k') { edit(value.slice(0, cursor), cursor); return; }     // 刪到行尾
    if (key.backspace || key.delete) {
      const r = backspaceAt(value, cursor); // 游標在貼上占位符末端→原子刪整個占位符
      if (r.value !== value || r.cursor !== cursor) edit(r.value, r.cursor);
      return;
    }
    if (input) {
      // 多行貼上：折疊成占位符 ⟦貼上#n·N行⟧，不撐爆輸入框；送出時展開（對標 Claude Code）
      if (input.includes('\n') && input.length > 1) {
        const id = pastes.length + 1;
        const token = `⟦貼上#${id}·${input.split('\n').length}行⟧`;
        setPastes((p) => [...p, input]);
        edit(value.slice(0, cursor) + token + value.slice(cursor), cursor + token.length);
      } else {
        edit(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
      }
    }
  });

  // 空輸入時，ghost 建議優先顯示（附 ⇥ 提示）；否則顯示 placeholder
  const hint = ghost ? `${ghost}  \x1b[2m⇥ Tab\x1b[22m` : placeholder;
  const lines = renderValue(value, cursor, hint).split('\n');
  return h(
    Box,
    { flexDirection: 'column' },
    h(Box, null, h(Text, { color: promptColor }, promptPrefix), h(Text, null, lines[0])),
    ...lines.slice(1).map((ln, i) => h(Text, { key: 'l' + i }, '  ' + ln)),
    menu
      ? h(Box, { flexDirection: 'column' },
          ...menu.items.slice(0, 8).map((it, i) => {
            const val = typeof it === 'string' ? it : it.value;
            const desc = typeof it === 'string' ? '' : (it.desc ? '  \x1b[90m' + it.desc + '\x1b[39m' : '');
            return h(Text, { key: 'm' + i, color: i === menu.index ? 'cyan' : 'gray' }, (i === menu.index ? '❯ ' : '  ') + val + desc);
          }))
      : null,
  );
}

export function App({ store, handlers }) {
  const [, force] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const s = store.get();

  // spinner / 耗時計時：執行中每 120ms 重繪
  useEffect(() => {
    if (s.mode !== 'busy') return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, [s.mode]);

  // 註：終端 resize 由 tui-run.js 的 runTui（onResize）處理（debounce 後全清螢幕 + 卸載重掛），
  // 因為 Ink 的增量清行會用「換行數」而非「實際終端列數」計算，視窗變窄時會誤算並殘留亂碼。

  const elapsed = s.busyAt ? Math.floor((Date.now() - s.busyAt) / 1000) : 0;
  // 工具執行中優先「執行中」；否則只要本段在吐字（live 有值或 outputting 旗標）就「輸出中」，不因區塊提交瞬間閃回思考中
  const verb = s.tool ? '執行中' : (s.live || s.outputting) ? '輸出中' : waitingVerb(elapsed);
  const tokPart = s.turnTok ? ` · ↑ ${fmtTok(s.turnTok)}` : ''; // 即時累計 token（對標 Claude Code）
  const waiting = s.mode === 'busy'
    ? `\x1b[35m${SPINNER[tick % SPINNER.length]} ${verb}… ${elapsed}s${tokPart}\x1b[39m ` +
      GRAY('· 直接打字=引導，Esc/Ctrl+C 中斷')
    : null;

  const borderColor = s.mode === 'ask' ? 'cyan' : s.mode === 'busy' ? 'magenta' : s.planMode ? 'cyan' : 'gray';
  const promptColor = s.mode === 'ask' ? 'cyan' : s.planMode ? 'cyan' : 'green';

  // 狀態列：模型 · 目錄 · [計劃] · 上下文 N%
  let ctxPart = '';
  if (s.ctx && s.ctx.total) {
    const pct = Math.min(100, Math.round((s.ctx.used / s.ctx.total) * 100));
    const col = pct >= 90 ? '31' : pct >= 70 ? '33' : '90';
    ctxPart = ` \x1b[90m·\x1b[39m \x1b[${col}m上下文 ${pct}%\x1b[39m`;
  }
  const planPart = s.planMode ? ' \x1b[90m·\x1b[39m \x1b[36m[計劃]\x1b[39m' : '';
  const permPart = s.permLabel ? ' \x1b[90m·\x1b[39m \x1b[32m' + s.permLabel + '\x1b[39m' : '';
  const sandboxPart = s.sandboxLabel ? ' \x1b[90m·\x1b[39m \x1b[33m' + s.sandboxLabel + '\x1b[39m' : '';
  const gitPart = s.gitLabel ? ' \x1b[90m·\x1b[39m ' + GRAY(s.gitLabel) : '';
  const statusBar = GRAY(`${s.modelLabel}  ${s.cwdLabel}`) + gitPart + planPart + permPart + sandboxPart + ctxPart;

  // 不再用 spacer 把輸入框頂到屏底。原本算高度撐滿整屏，會讓「活動區」逼近終端列數；
  // 一旦 outputHeight >= rows，Ink 改走 clearTerminal 全屏重繪慢路徑（Windows conhost 上劇烈閃爍/跳動）。
  // 改為自頂向下自然捲動：歷史進 <Static>（不計入活動區高度），活動區恆只剩 串流/狀態/輸入 幾行，
  // Ink 永遠走 eraseLines 增量快路徑。輸入框在內容填滿一屏後自然落到底部（對標 Claude Code）。
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { items: s.transcript }, (item) => h(Box, { key: item.id, flexDirection: 'column' }, h(Text, null, item.text))),
    s.thinking ? h(Text, { color: 'gray', wrap: 'wrap' }, s.thinking) : null,
    s.live ? h(Box, { flexDirection: 'column' }, h(Text, null, '\n' + gutter(
      s.liveCodeLang != null ? codeChunk(s.live, s.liveCodeLang, false) : md(s.live),
      s.liveStarted ? '' : DOT))) : null,
    s.tool ? h(Text, { color: 'yellow' }, `⏺ ${s.tool.name}`, s.tool.summary ? h(Text, { color: 'gray' }, `(${s.tool.summary})`) : null) : null,
    waiting ? h(Text, null, waiting) : null,
    s.ask ? h(Text, null, s.ask.prompt) : null,
    s.status ? h(Text, null, '  ' + s.status) : null,
    // 任務面板：就地更新的活動區元素（非 Static），每次 task_update 在原位重畫、不堆歷史
    s.tasks ? h(Box, { flexDirection: 'column' }, h(Text, null, GRAY('  任務')), h(Text, null, s.tasks)) : null,
    statusBar.trim() ? h(Text, null, '  ' + statusBar) : null,
    (s.mode === 'idle' && !s.selection) ? h(Text, null, GRAY('  ↵ 送出 · ⇧↵ 換行 · / 指令 · @ 檔案 · ↑ 歷史')) : null,
    // 最底：選單模式渲染 <Select>（取代輸入框），否則渲染輸入框
    s.selection
      ? h(Select, {
          title: s.selection.title,
          options: s.selection.options,
          onSelect: handlers.onSelectChoice,
          onCancel: handlers.onSelectCancel,
          onAbort: handlers.onSelectAbort,
        })
      : h(Box, { borderStyle: 'round', borderColor, paddingX: 1, marginTop: 1 },
          h(Input, {
            onSubmit: handlers.onSubmit,
            onCtrlC: handlers.onCtrlC,
            onEscape: handlers.onEscape,
            getHistory: handlers.getHistory,
            // ask 模式（自行輸入答案）為純文字：關閉斜線/@補全與 ghost 建議，避免 `/`、`@` 誤彈選單
            complete: s.mode === 'ask' ? undefined : handlers.complete,
            placeholder: s.mode === 'ask' ? '輸入你的答案，Enter 送出 · Esc 取消' : s.placeholder,
            promptPrefix: s.mode === 'ask' ? '› ' : (s.planMode ? '[計劃] › ' : '› '),
            promptColor,
            suggestions: s.mode === 'ask' ? [] : s.suggestions,
          })),
  );
}

// 掛載 TUI；回傳 Ink instance（含 unmount / waitUntilExit）
export function mountTui({ store, handlers }) {
  return render(h(App, { store, handlers }), { exitOnCtrlC: false });
}
