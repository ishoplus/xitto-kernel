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
export function runCli({ pack, model, getApiKey, sandbox = false }) {
  let sandboxOn = !!sandbox;
  const kernel = createKernel(pack, {
    model, getApiKey,
    sandbox: { enabled: sandboxOn },        // 提供策略（blockNetwork/allowWritePrefixes）
    getSandbox: () => sandboxOn,            // on/off 由 CLI 即時切換
  });

  let history = [];
  let currentAgent = null;
  let streaming = false;

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
          '  /tools           列出此 pack 的工具',
          '  /clear           清除對話歷史',
          '  /exit            離開',
        ].join('\n') + '\n'));
        return true;
      case '/sandbox': {
        sandboxOn = arg ? arg === 'on' : !sandboxOn;
        const real = seatbeltAvailable();
        out(sandboxOn
          ? c.yellow(`🔒 沙箱開${real ? '（macOS Seatbelt OS 級隔離）' : '（靜態策略；此平台無 Seatbelt）'}\n`)
          : c.gray('沙箱關\n'));
        return true;
      }
      case '/tools':
        out(c.gray(kernel.registry.all().map((t) =>
          `  ${t.name}${t.readOnly ? c.gray(' [唯讀]') : ''}${t.mutating ? c.yellow(' [mutating]') : ''}${t.sandboxable ? c.cyan(' [sandboxable]') : ''}`,
        ).join('\n') + '\n'));
        return true;
      case '/clear': history = []; out(c.gray('（已清除對話歷史）\n')); return true;
      default:
        if (cmd.startsWith('/')) { out(c.red(`未知指令 ${cmd}（/help）\n`)); return true; }
        return false;
    }
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.blue('› ') });
  let closed = false;
  const cleanup = () => { try { rl.close(); } catch { /* 略 */ } };
  const finish = () => { cleanup(); process.exit(0); };
  rl.on('close', () => { closed = true; }); // 管線輸入結束（非 TTY）→ 收尾

  // Ctrl+C：執行中→中斷該輪；閒置→離開
  process.on('SIGINT', () => {
    if (currentAgent) { currentAgent.abort(); out(c.yellow('\n⏹ 已中斷本輪\n')); }
    else { out(c.gray('\n再見。\n')); cleanup(); process.exit(0); }
  });

  // 橫幅
  out('\n' + c.cyan('✻ ') + c.bold('xitto-kernel') + c.gray(`  ·  ${pack.name} pack  ·  ${model.id}`) + '\n');
  out(c.gray(`  沙箱 ${sandboxOn ? '開' : '關'}${seatbeltAvailable() ? '（Seatbelt 可用）' : ''}  ·  /help 看指令  ·  Ctrl+C 中斷/離開`) + '\n\n');

  const loop = () => {
    if (closed) return finish();
    let q;
    try { q = rl.question.bind(rl); } catch { return finish(); }
    q(c.blue('› '), async (raw) => {
      const input = (raw || '').trim();
      if (!input) return loop();
      if (handleSlash(input)) return loop();
      try {
        const r = await kernel.runTurn(input, {
          history, onEvent, onAgent: (a) => { currentAgent = a; },
        });
        endStream();
        history = r.messages;
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
