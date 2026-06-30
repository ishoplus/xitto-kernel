// 自訂 agent 類型 — kernel 內建（對標 Claude Code 的 subagents）。
// 從 <dataDir>/agents/*.md 載入「具名、專長化」的子 agent 定義：
//   frontmatter: name、description（何時用，給主 agent 依此委派）、tools（可選工具白名單，逗號分隔）
//   body: 該類型的 system prompt
// spawn_agent / spawn_agents 用 agentType 指定 → 以該類型的 prompt + 工具子集跑子 agent。
// 定義是純文字（非可執行碼），自寫安全——name slug 化、tools 僅做白名單過濾。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function splitFront(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { fm, body: m[2] };
}
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9一-龥_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

export function createAgents(dir) {
  const readAll = () => {
    const out = [];
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        try {
          const { fm, body } = splitFront(readFileSync(join(dir, f), 'utf8'));
          const name = slug(fm.name || f.replace(/\.md$/, ''));
          const sp = body.trim();
          if (!name || !sp) continue;
          const tools = fm.tools ? String(fm.tools).split(',').map((t) => t.trim()).filter(Boolean) : null;
          out.push({ name, description: (fm.description || '').trim(), tools, model: (fm.model || '').trim() || null, systemPrompt: sp });
        } catch { /* 壞檔略 */ }
      }
    }
    return out;
  };
  let cache = readAll();
  const get = (name) => { const n = slug(name); return cache.find((a) => a.name === n) || (cache = readAll()).find((a) => a.name === n) || null; };
  const list = () => cache.map(({ name, description, tools }) => ({ name, description, tools }));
  const promptSection = () => (cache.length
    ? '\n\n# 可用的 agent 類型（委派專長子 agent：spawn_agent/spawn_agents 帶 agentType 指定；省略則用預設唯讀調查員）\n'
      + cache.map((a) => `- ${a.name}：${a.description}`).join('\n')
    : '');
  return { get, list, promptSection, reload: () => { cache = readAll(); return cache; }, count: () => cache.length };
}
