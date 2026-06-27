// 產生 SWE-bench predictions.jsonl —— 對每個 instance：clone repo@base_commit、跑 xitto-kernel
// coding pack、git diff 當 model_patch。之後用官方 swebench harness（Docker）跑隱藏測試評估。
// 用法：
//   node eval/swebench-generate.js --instances verified.jsonl --limit 20 --out predictions.jsonl
// （verified.jsonl：從 HuggingFace princeton-nlp/SWE-bench_Verified 匯出的逐行 JSON）
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadModel } from '../src/app/providers.js';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const instancesPath = opt('--instances');
const limit = parseInt(opt('--limit', '5'), 10);
const out = opt('--out', 'predictions.jsonl');
const cacheDir = opt('--cache', join(process.cwd(), '.swebench-repos'));
const maxRounds = parseInt(opt('--rounds', '8'), 10);

if (!instancesPath) {
  console.error('用法: node eval/swebench-generate.js --instances <verified.jsonl> [--limit 20] [--out predictions.jsonl] [--rounds 8]');
  console.error('verified.jsonl 取得：HuggingFace datasets 載入 princeton-nlp/SWE-bench_Verified，逐筆 json.dumps 寫成一行一筆。');
  process.exit(1);
}

const lines = readFileSync(instancesPath, 'utf8').split('\n').filter(Boolean).slice(0, limit);
const { model, getApiKey } = loadModel();
mkdirSync(cacheDir, { recursive: true });
writeFileSync(out, '');

console.log(`產生 predictions：${lines.length} 題 · model ${model.id}\n`);
for (const line of lines) {
  const inst = JSON.parse(line);
  const { instance_id, repo, base_commit, problem_statement } = inst;
  process.stdout.write(`▶ ${instance_id} … `);
  let patch = '';
  try {
    const repoDir = join(cacheDir, repo.replace('/', '__'));
    if (!existsSync(repoDir)) sh(`git clone --quiet https://github.com/${repo} ${JSON.stringify(repoDir)}`, process.cwd());
    sh('git reset --hard --quiet HEAD && git clean -fdq', repoDir);
    sh(`git checkout --quiet ${base_commit}`, repoDir); // 完整 clone 故任意 commit 可 checkout

    const kernel = createKernel(createCodingPack({ cwd: repoDir }), { cwd: repoDir, model, getApiKey, confirm: async () => 'yes' });
    await kernel.runGoal(problem_statement, { maxRounds });
    patch = sh('git diff', repoDir);
    console.log(`patch ${patch ? patch.split('\n').length + ' 行' : '空'}`);
  } catch (e) {
    console.log('error: ' + String(e.message).slice(0, 120));
  }
  appendFileSync(out, JSON.stringify({ instance_id, model_name_or_path: 'xitto-kernel', model_patch: patch }) + '\n');
}

console.log(`\n✓ 已寫入 ${out}。接著用官方 harness 評估（需 Docker）：`);
console.log(`  pip install swebench`);
console.log(`  python -m swebench.harness.run_evaluation \\`);
console.log(`    --dataset_name princeton-nlp/SWE-bench_Verified \\`);
console.log(`    --predictions_path ${out} --max_workers 4 --run_id xitto1`);
