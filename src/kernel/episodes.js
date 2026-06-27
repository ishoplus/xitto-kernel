// 情節層沉澱 — kernel 內建。記「做過什麼任務、結果如何」,新任務時**按相關性召回**最相關的幾筆。
// 關鍵不在存,在召回對的那幾條：相關性評分（關鍵詞/中文 bigram 重疊 + tag 加權 + 近期微傾）,只注入 top-K。
// 落地 <cwd>/.xitto-kernel/<pack>/episodes.jsonl（一行一筆）；綁 cwd → 天然只召回這個專案的過往。
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

// 斷詞：ASCII 詞（≥2）+ 中文 bigram（無空格語言用 2-gram 抓近似）。回傳 term 陣列。
export function episodeTerms(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const w of s.match(/[a-z0-9]+/g) || []) if (w.length >= 2) out.push(w);
  for (const run of s.match(/[一-鿿]+/g) || []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter); };

// 相關性評分：summary 重疊 + tag 重疊(權重 2) + 近期微傾（相關度為主,近期只做平手時的微調）。
export function scoreEpisode(qSet, ep, now) {
  if (!qSet.size) return 0;
  const sum = ep._sum || new Set(episodeTerms(ep.summary));
  const tag = ep._tag || new Set((ep.tags || []).flatMap((t) => episodeTerms(t)));
  let overlap = 0; for (const q of qSet) if (sum.has(q)) overlap++;
  let tagHit = 0; for (const q of qSet) if (tag.has(q)) tagHit++;
  const base = overlap + 2 * tagHit;
  if (base <= 0) return 0;
  const ageDays = Math.max(0, (now - Date.parse(ep.ts || 0)) / 86400000) || 0;
  const recency = Number.isFinite(ageDays) ? Math.exp(-ageDays / 30) : 0; // ~30 天半衰
  return base * (1 + 0.3 * recency);
}

export function createEpisodes(file) {
  const all = () => {
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim(); if (!t) continue;
      try { const e = JSON.parse(t); if (e && e.summary) out.push(e); } catch { /* 跳壞行 */ }
    }
    return out;
  };

  const record = ({ summary, tags = [], outcome = null } = {}) => {
    const s = String(summary || '').trim();
    if (!s) return { error: 'summary 不可為空' };
    const cleanTags = (Array.isArray(tags) ? tags : [tags]).map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
    const newTerms = new Set(episodeTerms(s));
    // 去重：與既有情節 term 集 Jaccard > 0.85 視為重複,跳過
    for (const ep of all()) { if (jaccard(newTerms, new Set(episodeTerms(ep.summary))) > 0.85) return { skipped: true, similarTo: ep.id }; }
    const ep = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), summary: s, tags: cleanTags, outcome: outcome || null };
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(ep) + '\n');
    return { recorded: ep.id };
  };

  const recall = (query, limit = 5) => {
    const qSet = new Set(episodeTerms(query));
    if (!qSet.size) return [];
    const now = Date.now();
    return all()
      .map((ep) => ({ ep, score: scoreEpisode(qSet, ep, now) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map(({ ep, score }) => ({ id: ep.id, ts: ep.ts, summary: ep.summary, tags: ep.tags, outcome: ep.outcome, score: Math.round(score * 100) / 100 }));
  };

  // 自動召回：把與 input 最相關的 top-K 過往情節格成 prompt 區塊（無相關回 ''）。
  const recallSection = (query, limit = 4) => {
    const hits = recall(query, limit);
    if (!hits.length) return '';
    return '\n\n# 相關的過往經驗（按相關性召回，僅供參考，未必適用當前情境）\n' +
      hits.map((h) => `- ${h.summary}${h.outcome ? `（結果：${h.outcome}）` : ''}${h.tags?.length ? ` [${h.tags.join(', ')}]` : ''}`).join('\n');
  };

  const list = (n = 20) => all().slice(-n).reverse().map(({ id, ts, summary, tags, outcome }) => ({ id, ts, summary, tags, outcome }));
  const clear = () => { const n = all().length; try { if (existsSync(file)) writeFileSync(file, ''); } catch { /* 略 */ } return { cleared: n }; };

  const tools = [
    {
      name: 'episode_record', label: '記情節', readOnly: true,
      description: '完成一個有價值的任務後,記一筆「情節」:做了什麼、結果如何。給 summary（自給自足的一兩句）、tags（關鍵詞,助日後召回）、outcome（success/fail/可省）。日後遇到相似任務會被自動召回參考。與 memory/playbook 的差別:那兩個存「事實/做法」,episode 存「這次做過什麼」的事件。',
      parameters: { type: 'object', properties: { summary: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, outcome: { type: 'string', description: 'success | fail（可省）' } }, required: ['summary'] },
      execute: async (_id, args) => txt(record(args)),
    },
    {
      name: 'episode_recall', label: '召回情節', readOnly: true,
      description: '按相關性召回過往做過的相似任務（關鍵詞/語意重疊評分,回最相關幾筆）。開工前想參考「以前類似的怎麼處理」時用。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      execute: async (_id, { query, limit }) => txt({ recalled: recall(query, limit || 5) }),
    },
  ];

  return { record, recall, recallSection, list, all, clear, tools, count: () => all().length };
}
