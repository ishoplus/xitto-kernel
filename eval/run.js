// 跑迷你 benchmark，印 scoreboard（resolved 率 + token + 回合）。
// 用法：node eval/run.js   （需 ~/.xitto-code/providers.json）
import { loadModel } from '../src/app/providers.js';
import { runTask } from './harness.js';
import { TASKS } from './tasks.js';

const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const green = e(32); const red = e(31); const gray = e(90); const bold = e(1);

const { model, getApiKey } = loadModel();
console.log(bold(`\n=== xitto-kernel · SWE-bench 風格迷你評估 ===`) + gray(`  model: ${model.id}  ·  ${TASKS.length} 題\n`));

const results = [];
for (const task of TASKS) {
  process.stdout.write(`▶ ${task.id} … `);
  const t0 = Date.now();
  let r;
  try { r = await runTask(task, { model, getApiKey }); }
  catch (err) { console.log(red(`error: ${err.message}`)); results.push({ id: task.id, resolved: false, error: err.message, usage: { input: 0, output: 0 }, rounds: 0 }); continue; }
  const tok = r.usage.input + r.usage.output;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const sanity = r.preFails ? '' : gray('（注意：修復前測試竟通過，題目可能有問題）');
  console.log((r.resolved ? green('✅ resolved') : red('❌ unresolved')) + gray(`  ${r.rounds}輪 · ${tok} tok · ${secs}s`) + sanity);
  results.push(r);
}

const ok = results.filter((r) => r.resolved).length;
const tok = results.reduce((s, r) => s + (r.usage?.input || 0) + (r.usage?.output || 0), 0);
const rounds = results.reduce((s, r) => s + (r.rounds || 0), 0);
console.log(bold(`\n=== Scoreboard ===`));
console.log(`resolved : ${ok}/${results.length}  (${Math.round((100 * ok) / results.length)}%)`);
console.log(`tokens   : ${tok}  (avg ${Math.round(tok / results.length)}/題)`);
console.log(`rounds   : ${rounds}  (avg ${(rounds / results.length).toFixed(1)}/題)`);
console.log(gray('\n（這是自足迷你版，驗證流程與 SWE-bench 一致；接真實 SWE-bench Verified 見 eval/README.md）'));
process.exit(0);
