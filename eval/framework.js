// 可重用評分框架 —— 任何 pack 的 EvalSuite 都用它跑。
// 模式：建 kernel(pack) → runGoal(goal) → 取最終答案/狀態 → scorer 判定 → scoreboard。
// scorer：answerMatch(答案含字串) / stateCheck(對結果跑 shell 檢查) / 自訂函數。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createKernel } from '../src/kernel/index.js';

const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const green = e(32); const red = e(31); const gray = e(90); const bold = e(1);
const norm = (s) => String(s).toLowerCase().replace(/[\s,.'"`*_]/g, '');
const shOk = (cmd, cwd) => { try { execSync(cmd, { cwd, stdio: 'ignore' }); return true; } catch { return false; } };

// ── scorer 工廠 ──
export const answerMatch = (expect) => ({ answer }) => norm(answer).includes(norm(expect));
export const answerMatchAny = (...xs) => ({ answer }) => xs.some((x) => norm(answer).includes(norm(x)));
export const stateCheck = (cmd) => ({ dir }) => shOk(cmd, dir);

// 軌跡檢查（BFCL 風格）：agent 是否呼叫了某工具（可選 args 條件）。掃 history 的 toolCall。
export const toolCalled = (name, argPred) => ({ history }) =>
  (history || []).some((m) => m.role === 'assistant'
    && (m.content || []).some((c) => c.type === 'toolCall' && c.name === name && (!argPred || (() => { try { return argPred(c.arguments || {}); } catch { return false; } })())));

/**
 * 跑一個 EvalSuite。
 * @param {Object} o
 * @param {string} o.name
 * @param {(dir: string) => import('../src/types.js').DomainPack} o.pack  pack 工廠（吃工作目錄）
 * @param {Array<{ id, goal, setup?, prepare?, score }>} o.tasks
 *        setup：{path:content} 預置檔；prepare(dir)：async 預備（建 DB 等）；
 *        score({answer,dir,history})=>bool（可用 answerMatch/stateCheck）
 * @param {object} o.model
 * @param {Function} o.getApiKey
 * @param {boolean} [o.sandbox]
 * @param {number} [o.maxRounds]
 */
export async function runSuite({ name, pack, tasks, model, getApiKey, sandbox = false, maxRounds = 5 }) {
  console.log(bold(`\n=== ${name} ===`) + gray(`  model ${model.id} · ${tasks.length} 題\n`));
  const results = [];
  for (const task of tasks) {
    process.stdout.write(`▶ ${task.id} … `);
    const dir = mkdtempSync(join(tmpdir(), 'suite-'));
    try {
      if (task.setup) for (const [f, c] of Object.entries(task.setup)) { const p = join(dir, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
      if (task.prepare) await task.prepare(dir);
      const usage = { input: 0, output: 0 };
      const kernel = createKernel(pack(dir), { cwd: dir, model, getApiKey, sandbox: { enabled: sandbox }, getSandbox: () => sandbox, confirm: async () => 'yes' });
      const res = await kernel.runGoal(task.goal, {
        maxRounds,
        onEvent: (ev) => { if (ev.type === 'message_end' && ev.message?.usage) { usage.input += ev.message.usage.input || 0; usage.output += ev.message.usage.output || 0; } },
      });
      const answer = ([...res.history].reverse().find((m) => m.role === 'assistant')?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      const passed = !!task.score({ answer, dir, history: res.history });
      const tok = usage.input + usage.output;
      console.log((passed ? green('✅ pass') : red('❌ fail')) + gray(`  ${res.rounds}輪 · ${tok} tok  ${answer.replace(/\s+/g, ' ').trim().slice(0, 60)}`));
      results.push({ id: task.id, passed, rounds: res.rounds, usage });
    } catch (err) {
      console.log(red('error ' + err.message)); results.push({ id: task.id, passed: false, usage: {} });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const ok = results.filter((r) => r.passed).length;
  const tok = results.reduce((s, r) => s + (r.usage.input || 0) + (r.usage.output || 0), 0);
  const rounds = results.reduce((s, r) => s + (r.rounds || 0), 0);
  console.log(bold('\n=== Scoreboard ===') + `\n通過 ${ok}/${results.length} (${Math.round((100 * ok) / results.length)}%) · tokens ${tok} · avg ${(rounds / results.length).toFixed(1)} 輪/題`);
  return results;
}
