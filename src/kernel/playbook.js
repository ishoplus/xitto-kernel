// 專案手冊（程序層沉澱）— kernel 內建。agent 執行中把「這個專案怎麼做事」沉澱下來,跨 session 自動載入。
// 與 memory 的分工：memory 存「事實/偏好/決策」(扁平一行一條)；playbook 存「可重複的程序知識」
// (建置/測試/部署指令、慣例、必經步驟、踩過的坑與修法),按 topic 組織、同 topic 覆蓋(天然去重)。
// 落地到 <cwd>/.xitto-kernel/<pack>/playbook.md → 因綁 cwd,天然只對「這個專案」生效(自帶相關性範圍)。
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });
const HEADER = '# 專案手冊';

// 解析：以 `## <topic>` 分節,標題下方至下一個 `##` 為 note。
function parse(md) {
  if (!md) return [];
  const entries = [];
  for (const block of md.split(/\n(?=##\s)/)) {
    const m = block.match(/^##\s+(.+?)(?:\n([\s\S]*))?$/);
    if (!m) continue;
    const topic = m[1].trim();
    const note = (m[2] || '').trim();
    if (topic) entries.push({ topic, note });
  }
  return entries;
}

function serialize(entries) {
  return HEADER + '\n\n' + entries.map((e) => `## ${e.topic}\n${e.note}`).join('\n\n') + '\n';
}

/**
 * @param {string} file  手冊檔路徑（如 <cwd>/.xitto-kernel/<pack>/playbook.md）
 */
export function createPlaybook(file) {
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const list = () => parse(read());
  const load = () => read().trim();

  const writeEntries = (entries) => {
    if (!entries.length) { try { if (existsSync(file)) unlinkSync(file); } catch { /* 略 */ } return; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serialize(entries));
  };

  const update = (topic, note) => {
    const t = String(topic || '').trim();
    const n = String(note || '').trim();
    if (!t) return { error: 'topic 不可為空' };
    if (!n) return { error: 'note 不可為空' };
    const entries = list();
    const i = entries.findIndex((e) => e.topic.toLowerCase() === t.toLowerCase());
    if (i >= 0) {
      if (entries[i].note === n) return { skipped: true, topic: entries[i].topic };
      entries[i] = { topic: entries[i].topic, note: n }; // 保留原始大小寫,只換內容
      writeEntries(entries);
      return { updated: entries[i].topic };
    }
    entries.push({ topic: t, note: n });
    writeEntries(entries);
    return { added: t };
  };

  const remove = (topic) => {
    const t = String(topic || '').trim().toLowerCase();
    const entries = list();
    const kept = entries.filter((e) => e.topic.toLowerCase() !== t);
    if (kept.length === entries.length) return { error: '找不到主題', topic };
    writeEntries(kept);
    return { removed: topic };
  };

  const clear = () => { const n = list().length; writeEntries([]); return { cleared: n }; };

  // playbook_* 只動 kernel 自己的手冊檔（agent 簿記）,標 readOnly → 守衛鏈自動放行
  const tools = [
    {
      name: 'playbook_update', label: '記專案手冊', readOnly: true,
      description: '把這個專案的「做事方法」(程序知識)記下來或更新:建置/測試/執行/部署指令、專案慣例、必經步驟、踩過的坑與修法。按 topic 組織,同 topic 會覆蓋(避免重複)。下次 session 自動載入,省得重新摸索。與 memory 的差別:memory 存事實/偏好/決策,playbook 存可重複的程序步驟。',
      parameters: { type: 'object', properties: { topic: { type: 'string', description: '主題,如「測試」「建置」「部署地雷」' }, note: { type: 'string', description: '具體做法/步驟/注意事項' } }, required: ['topic', 'note'] },
      execute: async (_id, { topic, note }) => txt(update(topic, note)),
    },
    {
      name: 'playbook_remove', label: '清專案手冊', readOnly: true,
      description: '移除一條過時的專案手冊條目(按 topic)。手冊內容過時或錯誤時清掉,避免誤導未來的 session。',
      parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
      execute: async (_id, { topic }) => txt(remove(topic)),
    },
  ];

  return { load, list, update, remove, clear, tools };
}
