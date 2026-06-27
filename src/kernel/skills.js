// Skills（漸進揭露 + 結晶層）— kernel 內建。.xitto-kernel/<pack>/skills/*.md 每檔一個技能。
// system prompt 只列「名稱 + 簡述」；agent 用 skill 工具按名載入完整步驟。對標 xitto-code skills。
// 結晶層：agent 把重複出現的流程用 skill_save 寫成新技能（熱掃描,當下即可載入；下次 session 自動列出）。
// 技能是 markdown 指令(非可執行碼),自寫安全——名稱 slug 化防路徑穿越,內容只是日後注入的提示文字。
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

const firstDesc = (body) => {
  const fm = body.match(/^description:\s*(.+)$/mi);
  if (fm) return fm[1].trim();
  return (body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)) || '';
};

// 技能名 → 安全檔名 slug（防 ../ 穿越；保留中英數與連字號）
const slug = (s) => String(s || '').trim().toLowerCase()
  .replace(/[^a-z0-9一-龥_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

export function createSkills(dir) {
  const readAll = () => {
    const out = [];
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        try { const body = readFileSync(join(dir, f), 'utf8'); out.push({ name: f.replace(/\.md$/, ''), desc: firstDesc(body), body }); } catch { /* 略 */ }
      }
    }
    return out;
  };

  let skills = readAll(); // 啟動快照（供 system prompt 的 promptSection 列名用）

  const promptSection = () => (skills.length
    ? '\n\n# 可用技能（需要時用 skill 工具按名載入完整步驟；摸出可重複流程可用 skill_save 結晶成新技能）\n' + skills.map((s) => `- ${s.name}：${s.desc}`).join('\n')
    : '\n\n# 技能\n尚無已存技能。摸出一套可重複的流程時，用 skill_save 把它結晶成技能，之後（與未來 session）即可按名複用。');

  // 載入技能：每次 rescan → 找得到本 session 剛 skill_save 的技能
  const loadTool = {
    name: 'skill', label: '載入技能', readOnly: true,
    description: '按名載入一個技能的完整步驟（漸進揭露：prompt 只列名稱+簡述，需要時才載全文）。',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    execute: async (_id, { name }) => {
      skills = readAll();
      const s = skills.find((x) => x.name === name) || skills.find((x) => x.name === slug(name));
      return txt(s ? s.body : { error: '找不到技能', name, available: skills.map((x) => x.name) });
    },
  };

  // 結晶層：把可重複流程寫成新技能（或更新同名）。下次 session 自動列入可用技能。
  const saveTool = {
    name: 'skill_save', label: '結晶技能', readOnly: true,
    description: '把一套你摸出來、會重複用到的流程「結晶」成可複用技能（markdown 步驟）。給簡短 name、一句 description、完整 body（步驟/注意事項）。存後立刻可用 skill 按名載入，未來 session 也會自動列出。與 playbook 的差別：playbook 是專案事實性 know-how，skill 是可複用的操作流程/SOP。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能短名（會 slug 化為檔名）' },
        description: { type: 'string', description: '一句話簡述（列在 prompt 的技能清單）' },
        body: { type: 'string', description: '完整步驟內容（markdown）' },
      },
      required: ['name', 'body'],
    },
    execute: async (_id, { name, description, body }) => {
      const nm = slug(name);
      if (!nm) return txt({ error: 'name 不合法（需含中英數）' });
      if (!body || !String(body).trim()) return txt({ error: 'body 不可為空' });
      const desc = String(description || '').replace(/\s+/g, ' ').trim();
      const fm = desc ? `---\ndescription: ${desc}\n---\n\n` : '';
      try {
        mkdirSync(dir, { recursive: true });
        const existed = existsSync(join(dir, `${nm}.md`));
        writeFileSync(join(dir, `${nm}.md`), fm + String(body).trim() + '\n');
        skills = readAll();
        return txt({ [existed ? 'updated' : 'saved']: nm, hint: '已結晶為技能；本 session 可用 skill 工具按名載入，下次 session 會自動列入可用技能。' });
      } catch (e) { return txt({ error: e.message }); }
    },
  };

  const remove = (name) => {
    const nm = slug(name);
    const file = join(dir, `${nm}.md`);
    if (!existsSync(file)) return { error: '找不到技能', name };
    try { unlinkSync(file); skills = readAll(); return { removed: nm }; } catch (e) { return { error: e.message }; }
  };

  return {
    skills, promptSection,
    tool: loadTool,                 // 向後相容（舊呼叫點）
    tools: [loadTool, saveTool],    // kernel 注入用
    list: () => readAll().map(({ name, desc }) => ({ name, desc })),
    remove,
    reload: () => { skills = readAll(); return skills; },
  };
}
