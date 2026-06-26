// notes pack — 第三個範例領域：知識庫 / 筆記 agent。
// 用來示範「怎麼從零做一個新領域 agent」（見 docs/06-authoring-a-pack.md）。
// 工具操作 <cwd>/.notes/*.md；preToolPolicy 用 search-before-add（對照 read-before-edit）。
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });
const slug = (t) => String(t).trim().toLowerCase().replace(/[^\w一-鿿]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note';

const SYSTEM_PROMPT = [
  '你是知識庫助手，管理使用者的筆記。準則：',
  '- 新增筆記前，先 search_notes 確認沒有重複或相關條目。',
  '- 回答問題時優先 search_notes / read_note 找既有筆記，不要憑空編造。',
].join('\n');

/**
 * @param {{ cwd?: string }} [opts]
 * @returns {import('../../types.js').DomainPack}
 */
export function createNotesPack({ cwd = process.cwd() } = {}) {
  const dir = join(cwd, '.notes');
  const searched = new Set(); // 已 search/list 過（search-before-add 守衛用）
  const ensure = () => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); };
  const all = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : []);

  const listNotes = {
    name: 'list_notes', label: '列筆記', description: '列出所有筆記標題', readOnly: true,
    parameters: { type: 'object', properties: {} },
    execute: async () => { searched.add('*'); return txt(all().map((f) => f.replace(/\.md$/, '')) || []); },
  };
  const searchNotes = {
    name: 'search_notes', label: '搜尋筆記', description: '依關鍵字搜尋筆記標題與內容', readOnly: true,
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute: async (_id, { query }) => {
      searched.add('*');
      const q = String(query || '').toLowerCase();
      const hits = all().filter((f) => (f + readFileSync(join(dir, f), 'utf8')).toLowerCase().includes(q));
      return txt({ query, hits: hits.map((f) => f.replace(/\.md$/, '')) });
    },
  };
  const readNote = {
    name: 'read_note', label: '讀筆記', description: '讀取某篇筆記內容', readOnly: true,
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    execute: async (_id, { title }) => {
      const p = join(dir, slug(title) + '.md');
      return existsSync(p) ? txt(readFileSync(p, 'utf8')) : txt({ error: '找不到筆記', title });
    },
  };
  const addNote = {
    name: 'add_note', label: '新增筆記', description: '新增一篇筆記（標題 + 內容）', mutating: true,
    parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
    execute: async (_id, { title, body }) => {
      ensure();
      const p = join(dir, slug(title) + '.md');
      writeFileSync(p, `# ${title}\n\n${body}\n`, 'utf8');
      return txt({ saved: title, file: p });
    },
  };

  return {
    name: 'notes',
    tools: () => [listNotes, searchNotes, readNote, addNote],
    systemPrompt: SYSTEM_PROMPT,
    contextFiles: ['NOTES.md'],
    // mutatingTools 省略 → 從 metadata 推導（add_note）
    preToolPolicy: {
      // search-before-add：沒先 search/list 就新增 → 擋（避免重複，對照 read-before-edit）
      check: (ctx) => {
        if (ctx.name === 'add_note' && !searched.has('*')) {
          return { block: true, reason: '新增前請先 search_notes 或 list_notes 確認沒有重複。' };
        }
        return undefined;
      },
    },
    permissionPolicy: { defaultMode: 'default' },
  };
}

export const notesPack = createNotesPack();
