// 通用 agent 評分 harness（GAIA 風格）：給目標 → agent 用工具完成 → 檢查最終答案或結果狀態。
// 兩種判定：expect（最終答案需含某字串，正規化比對）或 verify（對結果狀態跑 shell 檢查）。
// 用法：node eval/general-run.js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadModel } from '../src/app/providers.js';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const green = e(32); const red = e(31); const gray = e(90); const bold = e(1);
const norm = (s) => String(s).toLowerCase().replace(/[\s,.'"`*]/g, '');
const sh = (cmd, cwd) => { try { execSync(cmd, { cwd, stdio: 'ignore' }); return true; } catch { return false; } };

// 任務：goal + (expect 最終答案含字串 | verify 結果狀態檢查)。各任務鍛鍊不同工具。
const TASKS = [
  { id: 'math（bash）', goal: '計算 1 到 100 的整數總和，可用 bash 跑程式驗算。最後只回答那個數字。', expect: '5050' },
  { id: 'file（檔案）', goal: '在工作目錄建一個 data.json，內容是 {"ok": true}。建好後讀回確認。', verify: 'test -f data.json && grep -q ok data.json' },
  { id: 'api（http）', goal: '用 http 工具呼叫 https://api.github.com/repos/ishoplus/xitto-kernel（headers 帶 user-agent: xitto），回答這個 repo 的主要程式語言（language 欄位）。只回答語言名稱。', expect: 'JavaScript' },
  { id: 'web（web_search）', goal: '用 web_search 查 Model Context Protocol（MCP）是哪一家公司提出的。只回答公司名稱。', expect: 'Anthropic' },
];

async function runTask(task, { model, getApiKey }) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-eval-'));
  try {
    const usage = { input: 0, output: 0 };
    const kernel = createKernel(createGeneralPack({ cwd: dir }), {
      cwd: dir, model, getApiKey,
      sandbox: { enabled: false }, getSandbox: () => false, // 需網路 → 不沙箱
      confirm: async () => 'yes',
    });
    const res = await kernel.runGoal(task.goal, {
      maxRounds: 5,
      onEvent: (ev) => { if (ev.type === 'message_end' && ev.message?.usage) { usage.input += ev.message.usage.input || 0; usage.output += ev.message.usage.output || 0; } },
    });
    const answer = ([...res.history].reverse().find((m) => m.role === 'assistant')?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const passed = task.expect ? norm(answer).includes(norm(task.expect)) : sh(task.verify, dir);
    return { id: task.id, passed, rounds: res.rounds, usage, answer: answer.replace(/\s+/g, ' ').trim().slice(0, 80) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const { model, getApiKey } = loadModel();
console.log(bold('\n=== xitto-kernel · 通用 agent 評分（GAIA 風格）===') + gray(`  model ${model.id}  ·  ${TASKS.length} 題\n`));
const results = [];
for (const task of TASKS) {
  process.stdout.write(`▶ ${task.id} … `);
  let r; try { r = await runTask(task, { model, getApiKey }); } catch (err) { console.log(red('error ' + err.message)); results.push({ passed: false, usage: {} }); continue; }
  const tok = (r.usage.input || 0) + (r.usage.output || 0);
  console.log((r.passed ? green('✅ pass') : red('❌ fail')) + gray(`  ${r.rounds}輪 · ${tok} tok`) + gray(`  ans: ${r.answer}`));
  results.push(r);
}
const ok = results.filter((r) => r.passed).length;
const tok = results.reduce((s, r) => s + (r.usage.input || 0) + (r.usage.output || 0), 0);
console.log(bold('\n=== Scoreboard ===') + `\n通過: ${ok}/${results.length} (${Math.round(100 * ok / results.length)}%)  ·  tokens ${tok}`);
process.exit(0);
