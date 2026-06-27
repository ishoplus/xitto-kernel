// 後台進程 — bash_bg / bash_output / bash_kill。對標 Claude Code 的 run_in_background + BashOutput + KillShell。
// 讓 agent 啟動 dev server / watch / build 而不阻塞對話。輸出緩衝在記憶體（上限裁切前段）。
import { spawn } from 'node:child_process';

const OUTPUT_CAP = 256 * 1024;
const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

// 全域只註冊一次 process 退出清理（避免每個 pack 各註冊造成 listener 洩漏）
const cleanups = new Set();
let registered = false;
const ensureCleanup = () => { if (registered) return; registered = true; const run = () => { for (const c of cleanups) try { c(); } catch { /* 略 */ } }; process.once('exit', run); process.once('SIGTERM', run); };

export function createBackgroundTools(cwd) {
  const procs = new Map();
  let seq = 0;
  const append = (proc, d) => {
    proc.buf += d.toString();
    if (proc.buf.length > OUTPUT_CAP) { const drop = proc.buf.length - OUTPUT_CAP; proc.buf = proc.buf.slice(drop); proc.readPos = Math.max(0, proc.readPos - drop); proc.truncated = true; }
  };
  const killAll = () => { for (const p of procs.values()) if (p.status === 'running') { try { p.child?.kill('SIGTERM'); } catch { /* 略 */ } } };
  cleanups.add(killAll); ensureCleanup();

  const bashBg = {
    name: 'bash_bg', label: '後台執行', mutating: true, sandboxable: true,
    description: '在後台啟動長時間/常駐命令（dev server、watch、build），立即回傳 id 不阻塞。之後 bash_output 讀新輸出、bash_kill 終止。一次性快命令用一般 bash。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (_id, { command }) => {
      const cmd = (command || '').trim();
      if (!cmd) return txt({ error: 'command 不可為空' });
      const id = 'bg' + (++seq);
      const proc = { id, command: cmd, status: 'running', exitCode: null, buf: '', readPos: 0, truncated: false };
      let child;
      try { child = spawn(cmd, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { proc.status = 'error'; proc.error = e.message; procs.set(id, proc); return txt({ error: e.message }); }
      proc.child = child;
      child.stdout?.on('data', (d) => append(proc, d));
      child.stderr?.on('data', (d) => append(proc, d));
      child.on('exit', (code) => { proc.status = 'exited'; proc.exitCode = code; });
      child.on('error', (e) => { proc.status = 'error'; proc.error = e.message; });
      procs.set(id, proc);
      return txt({ id, status: 'running', hint: `bash_output("${id}") 讀輸出、bash_kill("${id}") 終止` });
    },
  };

  const bashOutput = {
    name: 'bash_output', label: '讀後台輸出', readOnly: true,
    description: '讀取某後台進程（bash_bg 啟動）自上次以來的新輸出與狀態（running/exited/error）。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (_id, { id }) => {
      const p = procs.get(id);
      if (!p) return txt({ error: `找不到後台進程 ${id}` });
      const out = p.buf.slice(p.readPos); p.readPos = p.buf.length;
      return txt({ id, status: p.status, exitCode: p.exitCode, ...(p.error ? { error: p.error } : {}), ...(p.truncated ? { truncatedFront: true } : {}), output: out });
    },
  };

  const bashKill = {
    name: 'bash_kill', label: '終止後台', readOnly: true,
    description: '終止一個仍在運行的後台進程（bash_bg 啟動的）。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (_id, { id }) => {
      const p = procs.get(id);
      if (!p) return txt({ error: `找不到後台進程 ${id}` });
      if (p.status !== 'running') return txt({ id, status: p.status, note: '進程已結束' });
      try { p.child?.kill('SIGTERM'); return txt({ id, killed: true }); } catch (e) { return txt({ id, error: e.message }); }
    },
  };

  return { tools: [bashBg, bashOutput, bashKill], killAll };
}
