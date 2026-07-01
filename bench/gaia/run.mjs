// GAIA 跑分 harness：把每題丟進 kernel（headless runOutcome），抽最終答案、用官方評分器判定，按 Level 統計。
//
// 用法：
//   node bench/gaia/run.mjs --data bench/gaia/samples.jsonl            # 先用內附樣本 smoke test
//   node bench/gaia/run.mjs --data ~/gaia/validation.jsonl --level 1  # 真實資料（見 README 取得方式）
//   node bench/gaia/run.mjs --data ... --model <id> --limit 10 --concurrency 3 --max-rounds 20
//
// 每題資料格式（JSONL，對齊 GAIA 欄位）：
//   { "task_id": "...", "Question": "...", "Level": 1, "Final answer": "...", "file_name": "可選附檔.xlsx" }
// 附檔放在 data 檔同層的 files/ 目錄（或 file_name 給絕對路徑）。
import { readFileSync, existsSync, mkdtempSync, copyFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { loadModel } from '../../src/app/providers.js';
import { createKernel } from '../../src/kernel/index.js';
import { createGeneralPack } from '../../src/packs/general/index.js';
import { questionScorer, extractFinalAnswer } from './scorer.mjs';
import { formatOrFallback } from './formatter.mjs';

// ── 參數 ──
function parseArgs(argv) {
  // formatter 預設關：在 MiniMax L1 上實測淨增益 +0（近似失分多為真內容錯，非格式），且多一次 LLM 呼叫。
  // 保留 --formatter 供實驗（有 formatOrFallback 保底，永不比 raw 抽取更差）。
  const o = { data: 'bench/gaia/samples.jsonl', model: undefined, level: 'all', limit: Infinity, concurrency: 3, maxRounds: 20, timeoutMs: 300000, pack: 'general', out: null, formatter: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--formatter') o.formatter = true;
    else if (a === '--no-formatter') o.formatter = false;
    else if (a === '--data') o.data = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--level') o.level = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]);
    else if (a === '--max-rounds') o.maxRounds = Number(argv[++i]);
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--out') o.out = argv[++i];
  }
  o.out ||= o.data.replace(/\.jsonl?$/, '') + '.results.jsonl';
  return o;
}

const GAIA_SYS = `You are a general AI assistant. I will ask you a question. Report your thoughts, and finish your answer with the following template: FINAL ANSWER: [YOUR FINAL ANSWER].
YOUR FINAL ANSWER should be a number OR as few words as possible OR a comma separated list of numbers and/or strings.
If you are asked for a number, don't use comma to write your number neither use units such as $ or percent sign unless specified otherwise.
If you are asked for a string, don't use articles, neither abbreviations (e.g. for cities), and write the digits in plain text unless specified otherwise.
If you are asked for a comma separated list, apply the above rules depending of whether the element to be put in the list is a number or a string.`;

const loadTasks = (path) => readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
const loadDone = (path) => (existsSync(path) ? new Set(loadTasks(path).map((r) => r.task_id)) : new Set());

// 有界並發
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; results[i] = await worker(items[i], i); }
  }));
  return results;
}

async function runTask(task, { model, getApiKey, resolveModel, dataDir, maxRounds, timeoutMs, formatter }) {
  const opts = { formatter };
  const cwd = mkdtempSync(join(tmpdir(), 'gaia-'));
  let filedNote = '';
  try {
    if (task.file_name) {
      // 附檔解析：絕對路徑 → GAIA 原生（與 metadata.jsonl 同層）→ 本 harness 慣例（files/ 子目錄）
      const cands = isAbsolute(task.file_name)
        ? [task.file_name]
        : [join(dataDir, task.file_name), join(dataDir, 'files', task.file_name)];
      const src = cands.find((p) => existsSync(p));
      if (src) { const dst = join(cwd, basename(task.file_name)); copyFileSync(src, dst); filedNote = `\n\n（附檔已放在工作目錄：${basename(task.file_name)}，可用 read 工具讀取）`; }
      else filedNote = `\n\n（註：本題有附檔 ${task.file_name} 但找不到檔案，將在無附檔情況下作答）`;
    }
    const kernel = createKernel(createGeneralPack({ cwd }), {
      cwd, model, getApiKey, resolveModel,
      sandbox: { enabled: false }, getSandbox: () => false,
      confirm: async () => 'yes',            // headless：自動核准 mutating
      autoRecordEpisode: false,              // 跑分不污染情節庫
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let out;
    try {
      out = await kernel.runOutcome(`${GAIA_SYS}\n\n---\n\nQuestion: ${task.Question}${filedNote}`, { maxRounds, signal: ac.signal });
    } finally { clearTimeout(timer); }
    const answerRaw = extractFinalAnswer(out.summary);
    let answer = answerRaw;
    if (opts.formatter) answer = await formatOrFallback({ model, getApiKey, resolveModel, question: task.Question, response: out.summary }, answerRaw);
    const correct = questionScorer(answer, task['Final answer'] ?? task.final_answer ?? '');
    return { task_id: task.task_id, level: task.Level ?? task.level ?? '?', correct, answer, answerRaw, expected: task['Final answer'] ?? task.final_answer, rounds: out.rounds, done: out.done, stalled: out.stalled, raw: String(out.summary || '').slice(-2500) };
  } catch (e) {
    return { task_id: task.task_id, level: task.Level ?? task.level ?? '?', correct: false, answer: '', expected: task['Final answer'], error: e.message };
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* 略 */ } }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!existsSync(o.data)) { console.error(`找不到資料檔：${o.data}（見 bench/gaia/README.md 取得 GAIA validation set）`); process.exit(1); }
  const { model, getApiKey, resolveModel } = loadModel(o.model);
  console.log(`GAIA harness · model=${model.id} · data=${o.data} · level=${o.level} · concurrency=${o.concurrency} · maxRounds=${o.maxRounds} · formatter=${o.formatter ? 'on' : 'off'}`);

  let tasks = loadTasks(o.data);
  if (o.level !== 'all') tasks = tasks.filter((t) => String(t.Level ?? t.level) === String(o.level));
  const done = loadDone(o.out);
  if (done.size) console.log(`（續跑：已完成 ${done.size} 題，跳過）`);
  tasks = tasks.filter((t) => !done.has(t.task_id)).slice(0, o.limit);
  console.log(`待跑 ${tasks.length} 題\n`);

  const dataDir = dirname(o.data);
  let n = 0;
  await pool(tasks, o.concurrency, async (task) => {
    const r = await runTask(task, { model, getApiKey, resolveModel, dataDir, maxRounds: o.maxRounds, timeoutMs: o.timeoutMs, formatter: o.formatter });
    appendFileSync(o.out, JSON.stringify(r) + '\n');
    n++;
    const mark = r.correct ? '✅' : (r.error ? '⚠️' : '❌');
    console.log(`${mark} [${n}/${tasks.length}] L${r.level} ${r.task_id} → 答「${String(r.answer).slice(0, 40)}」/ 標準「${String(r.expected).slice(0, 40)}」${r.error ? ' · ' + r.error : ''}`);
    return r;
  });

  // ── 統計（含先前已完成的）──
  const all = loadTasks(o.out);
  const byLevel = {};
  for (const r of all) { const L = r.level ?? '?'; (byLevel[L] ||= { n: 0, ok: 0 }); byLevel[L].n++; if (r.correct) byLevel[L].ok++; }
  const tot = all.length, ok = all.filter((r) => r.correct).length;
  console.log('\n=== GAIA 結果 ===');
  for (const L of Object.keys(byLevel).sort()) { const s = byLevel[L]; console.log(`Level ${L}: ${s.ok}/${s.n} = ${(100 * s.ok / s.n).toFixed(1)}%`); }
  console.log(`整體：${ok}/${tot} = ${(100 * ok / tot).toFixed(1)}%`);
  console.log(`明細：${o.out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
