// Skills（漸進揭露）— kernel 內建。.xitto-kernel/<pack>/skills/*.md 每檔一個技能。
// system prompt 只列「名稱 + 簡述」；agent 用 skill 工具按名載入完整步驟。對標 xitto-code skills。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

const firstDesc = (body) => {
  const fm = body.match(/^description:\s*(.+)$/mi);
  if (fm) return fm[1].trim();
  return (body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)) || '';
};

export function createSkills(dir) {
  const skills = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      try { const body = readFileSync(join(dir, f), 'utf8'); skills.push({ name: f.replace(/\.md$/, ''), desc: firstDesc(body), body }); } catch { /* 略 */ }
    }
  }

  const promptSection = () => (skills.length
    ? '\n\n# 可用技能（需要時用 skill 工具按名載入完整步驟）\n' + skills.map((s) => `- ${s.name}：${s.desc}`).join('\n')
    : '');

  const tool = skills.length ? {
    name: 'skill', label: '載入技能', readOnly: true,
    description: '按名載入一個技能的完整步驟（漸進揭露：prompt 只列名稱+簡述，需要時才載全文）。',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    execute: async (_id, { name }) => {
      const s = skills.find((x) => x.name === name);
      return txt(s ? s.body : { error: '找不到技能', name, available: skills.map((x) => x.name) });
    },
  } : null;

  return { skills, promptSection, tool };
}
