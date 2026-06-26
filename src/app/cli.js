// App 層：互動式終端 CLI，消費 kernel.runTurn 的事件流。
// 這是「kernel + 薄 app」的 app 半部——TUI 不在 kernel 內；更豐富的 Ink 前端可作為另一個
// app 消費同一組 kernel 事件（證明 kernel/app 分離）。
import readline from 'node:readline';
import { createKernel } from '../kernel/index.js';
import { seatbeltAvailable } from '../kernel/security/sandbox.js';

const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const c = { gray: e(90), green: e(32), yellow: e(33), red: e(31), cyan: e(36), bold: e(1), blue: e(34) };

const summarize = (args) => {
  const s = JSON.stringify(args ?? {});
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
};
const preview = (result) => {
  const t = (result?.content || []).map((x) => x.text || '').join(' ').replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 67) + '…' : t;
};

/**
 * 啟動互動 CLI。
 * @param {Object} o
 * @param {import('../types.js').DomainPack} o.pack
 * @param {object} o.model
 * @param {() => string} o.getApiKey
 * @param {boolean} [o.sandbox]   初始沙箱狀態（預設關）
 */
export function runCli({ pack, model, getApiKey, sandbox = false, resume = null, auto = false, extraTools = [], onExit = null }) {
  let sandboxOn = !!sandbox;
  let autoApprove = !!auto;
  let planMode = false;
  const kernel = createKernel(pack, {
    model, getApiKey, extraTools,
    sandbox: { enabled: sandboxOn },        // 提供策略（blockNetwork/allowWritePrefixes）
    getSandbox: () => sandboxOn,            // on/off 由 CLI 即時切換
    getPlanMode: () => planMode,            // 計劃模式：守衛擋 mutating 工具
    confirm: askConfirm,                    // 互動權限確認（mutating/危險工具執行前）
  });

  let history = [];
  let currentAgent = null;
  let streaming = false;

  // 互動權限確認：守衛鏈第 5 格對 mutating/危險工具呼叫此函數。autoApprove → 一律放行。
  // 回 'yes'（允許一次）/ 'always'（此工具全部）/ 'no'（拒絕）。
  async function askConfirm(name, args, danger) {
    if (autoApprove && !danger) return 'yes';   // 自動模式仍對危險命令把關
    endStream();
    return new Promise((res) => {
      const warn = danger ? c.red(`  ⛔ 危險：${danger}\n`) : '';
      out(warn + c.yellow('  需要許可 ') + c.bold(name) + c.gray('(' + summarize(args) + ')') + '\n');
      const hint = danger ? '[y]允許一次  [n]拒絕' : '[y]允許  [a]此工具全部  [n]拒絕';
      try {
        rl.question(c.yellow(`    ${hint} › `), (ans) => {
          const a = (ans || '').trim().toLowerCase();
          if (danger) return res(a === 'y' || a === 'yes' ? 'yes' : 'no');
          res(a === 'y' || a === 'yes' ? 'yes' : a === 'a' ? 'always' : 'no');
        });
      } catch { res('no'); }
    });
  }

  // session：續接（--resume [id]）或開新；每輪結束自動存檔
  let sessionId = kernel.session.newId();
  let resumedNote = '';
  if (resume) {
    const data = resume === true ? (kernel.session.latest() && kernel.session.load(kernel.session.latest().id)) : kernel.session.load(resume);
    if (data?.messages?.length) { history = data.messages; sessionId = data.id; resumedNote = `（續接 ${data.id}，${data.messages.length} 則）`; }
    else resumedNote = resume === true ? '（找不到可續的對話，開新）' : `（找不到 session "${resume}"，開新）`;
  }
  const persist = () => { try { kernel.session.save(sessionId, history); } catch { /* 略 */ } };

  const out = (s) => process.stdout.write(s);
  const endStream = () => { if (streaming) { out('\n'); streaming = false; } };

  const onEvent = (ev) => {
    switch (ev.type) {
      case 'message_update': {
        const a = ev.assistantMessageEvent;
        if (a?.type === 'text_delta' && a.delta) {
          if (!streaming) { out(c.green('● ')); streaming = true; }
          out(a.delta);
        }
        break;
      }
      case 'tool_execution_start':
        endStream();
        out(c.yellow('⚙ ' + ev.toolName) + c.gray('(' + summarize(ev.args) + ')\n'));
        break;
      case 'tool_execution_end':
        out((ev.isError ? c.red('  ⎿ ✗') : c.gray('  ⎿ ✓')) + c.gray(' ' + preview(ev.result)) + '\n');
        break;
      case 'verify_start':
        endStream();
        out(c.gray('  🔎 自動驗收…\n'));
        break;
      case 'verify_end':
        out(ev.ok ? c.gray('  ✓ 驗收通過\n') : c.yellow('  ✗ 驗收失敗，請 agent 修正…\n'));
        break;
      case 'hook_fail':
        out(c.yellow(`  ✗ hook 失敗 ${ev.command}，回灌讓 agent 修正…\n`));
        break;
    }
  };

  // 斜線指令；回 true 表示已處理（不送 LLM）
  const handleSlash = (input) => {
    const [cmd, arg] = input.trim().split(/\s+/);
    switch (cmd) {
      case '/exit': case '/quit': cleanup(); process.exit(0); return true;
      case '/help':
        out(c.gray([
          '  /help            說明',
          '  /sandbox [on|off] 切換沙箱（macOS=Seatbelt 真隔離）',
          '  /auto [on|off]    自動核准 mutating 工具（危險命令仍把關）',
          '  /plan [on|off]    計劃模式（只規劃、擋下實際改動）',
          '  /undo            撤銷上一次檔案改動（write/edit）',
          '  /tools           列出此 pack 的工具',
          '  /memory          顯示跨 session 記憶',
          '  /sessions        列出已保存的對話',
          '  /resume [id]     續接對話（不給 id=最近一次）',
          '  /clear           清除歷史（開新 session）',
          '  /exit            離開',
        ].join('\n') + '\n'));
        return true;
      case '/memory': {
        const mems = kernel.memory.list();
        out(mems.length ? c.gray(mems.map((m) => '  • ' + m).join('\n') + '\n') : c.gray('（尚無記憶）\n'));
        return true;
      }
      case '/sessions': {
        const ss = kernel.session.list();
        out(ss.length
          ? c.gray(ss.map((s) => `  ${s.id}  [${s.count} 則${s.model ? ' ' + s.model : ''}]`).join('\n') + '\n')
          : c.gray('（尚無保存的對話）\n'));
        return true;
      }
      case '/resume': {
        const target = arg || (kernel.session.latest()?.id);
        const data = target ? kernel.session.load(target) : null;
        if (data?.messages?.length) {
          history = data.messages; sessionId = data.id;
          out(c.gray(`（已續接 ${data.id}，${data.messages.length} 則）\n`));
        } else out(c.yellow(`找不到可續接的 session${arg ? ` "${arg}"` : ''}\n`));
        return true;
      }
      case '/sandbox': {
        sandboxOn = arg ? arg === 'on' : !sandboxOn;
        const real = seatbeltAvailable();
        out(sandboxOn
          ? c.yellow(`🔒 沙箱開${real ? '（macOS Seatbelt OS 級隔離）' : '（靜態策略；此平台無 Seatbelt）'}\n`)
          : c.gray('沙箱關\n'));
        return true;
      }
      case '/auto':
        autoApprove = arg ? arg === 'on' : !autoApprove;
        out(autoApprove ? c.yellow('⚡ 自動核准開（mutating 工具不再逐一確認；危險命令仍把關）\n') : c.gray('自動核准關（mutating 工具會逐一確認）\n'));
        return true;
      case '/plan':
        planMode = arg ? arg === 'on' : !planMode;
        out(planMode ? c.cyan('📋 計劃模式開（只規劃、擋下 write/edit/bash）\n') : c.gray('計劃模式關\n'));
        return true;
      case '/undo': {
        const r = kernel.undo();
        out(r.undone ? c.gray(`↩ 已撤銷 ${r.path}${r.created ? '（刪除新建檔）' : ''}\n`) : c.yellow(`${r.reason}\n`));
        return true;
      }
      case '/tools':
        out(c.gray(kernel.registry.all().map((t) =>
          `  ${t.name}${t.readOnly ? c.gray(' [唯讀]') : ''}${t.mutating ? c.yellow(' [mutating]') : ''}${t.sandboxable ? c.cyan(' [sandboxable]') : ''}`,
        ).join('\n') + '\n'));
        return true;
      case '/clear': history = []; sessionId = kernel.session.newId(); out(c.gray('（已清除歷史，開新 session）\n')); return true;
      default:
        if (cmd.startsWith('/')) { out(c.red(`未知指令 ${cmd}（/help）\n`)); return true; }
        return false;
    }
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.blue('› ') });
  let closed = false;
  const cleanup = () => { try { rl.close(); } catch { /* 略 */ } try { onExit?.(); } catch { /* 略 */ } };
  const finish = () => { cleanup(); process.exit(0); };
  rl.on('close', () => { closed = true; }); // 管線輸入結束（非 TTY）→ 收尾

  // Ctrl+C：執行中→中斷該輪；閒置→離開
  process.on('SIGINT', () => {
    if (currentAgent) { currentAgent.abort(); out(c.yellow('\n⏹ 已中斷本輪\n')); }
    else { out(c.gray('\n再見。\n')); cleanup(); process.exit(0); }
  });

  // 橫幅
  out('\n' + c.cyan('✻ ') + c.bold('xitto-kernel') + c.gray(`  ·  ${pack.name} pack  ·  ${model.id}`) + '\n');
  out(c.gray(`  沙箱 ${sandboxOn ? '開' : '關'}${seatbeltAvailable() ? '（Seatbelt 可用）' : ''}  ·  /help 看指令  ·  Ctrl+C 中斷/離開`) + '\n');
  if (resumedNote) out(c.gray('  ' + resumedNote) + '\n');
  out('\n');

  const loop = () => {
    if (closed) return finish();
    let q;
    try { q = rl.question.bind(rl); } catch { return finish(); }
    q(c.blue('› '), async (raw) => {
      const input = (raw || '').trim();
      if (!input) return loop();
      if (handleSlash(input)) return loop();
      try {
        const text = planMode
          ? `[計劃模式：只制定計劃，列出你打算做的步驟與會改動的檔案，不要實際寫檔或執行命令]\n\n${input}`
          : input;
        const r = await kernel.runTurn(text, {
          history, onEvent, onAgent: (a) => { currentAgent = a; },
        });
        endStream();
        history = r.messages;
        persist();                 // 每輪結束自動存檔（可 /resume 續接）
      } catch (err) {
        endStream();
        out(c.red('錯誤：' + err.message) + '\n');
      } finally {
        currentAgent = null;
      }
      out('\n');
      loop();
    });
  };
  loop();
}
