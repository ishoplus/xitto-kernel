// 離線重評：用已跑完 results 裡存的 raw summary，套上「答案格式化」pass 後重新評分，
// 量出格式化的「淨增益」——不重跑 agent，只花格式化那一次輕量呼叫。
//
// 用法：node bench/gaia/rescore.mjs --results <results.jsonl> --data <metadata.jsonl> [--concurrency 4]
import { readFileSync, existsSync } from 'node:fs';
import { loadModel } from '../../src/app/providers.js';
import { questionScorer } from './scorer.mjs';
import { formatOrFallback } from './formatter.mjs';

function parse(argv) {
  const o = { results: null, data: null, model: undefined, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') o.results = argv[++i];
    else if (a === '--data') o.data = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]);
  }
  return o;
}
const loadJsonl = (p) => readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

async function pool(items, n, worker) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i], i); }
  }));
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (!o.results || !existsSync(o.results)) { console.error('需 --results <已跑完的 results.jsonl>'); process.exit(1); }
  if (!o.data || !existsSync(o.data)) { console.error('需 --data <metadata.jsonl>（取原題目文字）'); process.exit(1); }
  const { model, getApiKey, resolveModel } = loadModel(o.model);
  const qById = new Map(loadJsonl(o.data).map((t) => [t.task_id, t.Question]));
  const rows = loadJsonl(o.results);

  let toFmt = rows.filter((r) => r.raw && qById.has(r.task_id));
  console.log(`重評 ${toFmt.length}/${rows.length} 題（有 raw 且找得到題目）· model=${model.id}\n`);

  const out = [];
  let n = 0;
  await pool(toFmt, o.concurrency, async (r) => {
    const fallback = r.answerRaw ?? r.answer;
    const formatted = await formatOrFallback({ model, getApiKey, resolveModel, question: qById.get(r.task_id), response: r.raw }, fallback);
    const nowCorrect = questionScorer(formatted, r.expected ?? '');
    const before = !!r.correct;
    out.push({ task_id: r.task_id, level: r.level, before, after: nowCorrect, old: r.answer, formatted, expected: r.expected });
    n++;
    const flip = before === nowCorrect ? '  ' : (nowCorrect ? '⤴️' : '⤵️');
    if (before !== nowCorrect) console.log(`${flip} L${r.level} ${r.task_id}: 「${String(r.answer).slice(0, 30)}」→「${String(formatted).slice(0, 30)}」/ 標準「${String(r.expected).slice(0, 30)}」`);
  });

  const gained = out.filter((r) => !r.before && r.after).length;   // ❌→✅
  const broke = out.filter((r) => r.before && !r.after).length;    // ✅→❌
  const beforeOk = out.filter((r) => r.before).length;
  const afterOk = out.filter((r) => r.after).length;
  console.log('\n=== 格式化 pass 淨增益 ===');
  console.log(`格式化前：${beforeOk}/${out.length} = ${(100 * beforeOk / out.length).toFixed(1)}%`);
  console.log(`格式化後：${afterOk}/${out.length} = ${(100 * afterOk / out.length).toFixed(1)}%`);
  console.log(`救回 ❌→✅：${gained} 題 · 弄壞 ✅→❌：${broke} 題 · 淨 ${gained - broke >= 0 ? '+' : ''}${gained - broke}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
