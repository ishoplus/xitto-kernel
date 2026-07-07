// Skills（漸進揭露 + 結晶層 + 自我維護）— kernel 內建。.xitto-kernel/<pack>/skills/*.md 每檔一個技能。
// system prompt 只列「名稱 + 簡述」；agent 用 skill 工具按名載入完整步驟。對標 xitto-code skills。
// 結晶層：agent 把重複流程用 skill_save 寫成新技能（須附 goal + 通過 verify 才落地）。
// 自我維護：載入時記使用戳記（usedCount/lastUsedAt）；skills_check 重跑各技能 verify 偵測漂移（stale）。
// 技能是 markdown 指令(非可執行碼),自寫安全——名稱 slug 化防穿越,內容只是日後注入的提示文字。
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

// 簡易 frontmatter（key: value 行）解析/序列化 + 不動 body 的 patch。
function splitFront(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { fm, body: m[2] };
}
function joinFront(fm, body) {
  const keys = Object.keys(fm);
  if (!keys.length) return body;
  return '---\n' + keys.map((k) => `${k}: ${fm[k]}`).join('\n') + '\n---\n\n' + body.replace(/^\n+/, '');
}
// verify 指令取自 `## 驗證…` 的 fenced sh 區塊（skill_save 寫入的格式；保留原樣含多行）。
function extractVerify(md) {
  const m = md.match(/##\s*驗證[^\n]*\n```(?:sh|bash)?\n([\s\S]*?)\n```/);
  return m ? m[1].trim() : null;
}
// 可執行腳本取自 `## 腳本（可執行）` 的 fenced 區塊（④：技能可帶腳本，supply skill_run 確定性重跑）。
function extractScript(md) {
  const m = md.match(/##\s*腳本[^\n]*\n```(?:sh|bash)?\n([\s\S]*?)\n```/);
  return m ? m[1].trim() : null;
}

const firstDesc = (body) => {
  const fm = body.match(/^description:\s*(.+)$/mi);
  if (fm) return fm[1].trim();
  return (body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)) || '';
};

const slug = (s) => String(s || '').trim().toLowerCase()
  .replace(/[^a-z0-9一-龥_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

export function createSkills(dir, { verifyRunner, capFilter } = {}) {
  const fileOf = (name) => join(dir, `${name}.md`);
  // capFilter(fm)：依環境能力篩技能（frontmatter 可標 `requires: cap,…` 或 `env: local`）。
  // 不通過的技能不列入 → 不出現在 prompt、skill 也載不到 → 錯環境下模型看不到無效技能。
  const allowFm = (fm) => (typeof capFilter !== 'function') || capFilter(fm);
  const readAll = () => {
    const out = [];
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        try {
          const md = readFileSync(join(dir, f), 'utf8');
          const { fm } = splitFront(md);
          if (!allowFm(fm)) continue; // 環境不支援 → 略過此技能
          out.push({ name: f.replace(/\.md$/, ''), desc: firstDesc(md), body: md, used: Number(fm.usedCount) || 0, stale: fm.stale === 'true' });
        } catch { /* 略 */ }
      }
    }
    return out;
  };
  const patch = (name, p) => {
    const file = fileOf(name);
    if (!existsSync(file)) return false;
    try { const { fm, body } = splitFront(readFileSync(file, 'utf8')); Object.assign(fm, p); writeFileSync(file, joinFront(fm, body)); return true; } catch { return false; }
  };

  let skills = readAll(); // 啟動快照（供 system prompt 列名用）
  const label = (s) => `- ${s.name}：${s.desc}${s.used ? `（用過 ${s.used} 次）` : ''}${s.stale ? ' ⚠ 已失效待修' : ''}`;

  const promptSection = () => (skills.length
    ? '\n\n# 可用技能（需要時用 skill 按名載入全文；摸出可重複流程可用 skill_save 結晶；⚠ 失效的先別用,可 skills_check 複查）\n' + skills.map(label).join('\n')
    : '\n\n# 技能\n尚無已存技能。摸出一套可重複的流程時，用 skill_save 把它結晶成技能（須附 goal + 通過 verify），之後即可按名複用。');

  // 載入技能：rescan → 找到剛存的；記使用戳記（A）
  const loadTool = {
    name: 'skill', label: '載入技能', readOnly: true,
    description: '按名載入一個技能的完整步驟（漸進揭露：prompt 只列名稱+簡述，需要時才載全文）。',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    execute: async (_id, { name }) => {
      skills = readAll();
      const s = skills.find((x) => x.name === name) || skills.find((x) => x.name === slug(name));
      if (!s) return txt({ error: '找不到技能', name, available: skills.map((x) => x.name) });
      patch(s.name, { usedCount: s.used + 1, lastUsedAt: new Date().toISOString() });
      skills = readAll();
      return txt(s.body);
    },
  };

  // 結晶層：把可重複流程寫成新技能。政策——須附 goal + 通過的 verify 才落地（verify 在沙箱實跑）。
  const saveTool = {
    name: 'skill_save', label: '結晶技能', readOnly: true,
    description: '把一套你摸出來、會重複用到的流程「結晶」成可複用技能。政策：每個技能必須附 (1) goal 明確目標 (2) verify 一條可驗證它有效的指令——verify 會被實際執行,通過(exit 0)才會新增,否則拒絕並回傳輸出讓你修正。確保結晶的是「已驗證的成功」。'
      + '可選附 (3) script：一段可執行腳本——日後用 skill_run 直接「確定性重跑」，不必每次重推步驟（交付「能力」而非一次性成品）。與 playbook 的差別：playbook 是專案事實性 know-how，skill 是可複用且已驗證的操作流程/SOP。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能短名（會 slug 化為檔名）' },
        goal: { type: 'string', description: '這個技能要達成的明確目標（一句話）' },
        body: { type: 'string', description: '完整步驟內容（markdown）' },
        verify: { type: 'string', description: '一條能驗證此技能/成果有效的 shell 指令（須 exit 0；如 `npm test`、`test -f dist/app.js`）。會被實際執行。' },
        script: { type: 'string', description: '可選；一段可執行 shell 腳本，封裝這個可重複流程。存檔後可用 skill_run <name> 直接重跑（確定性、免 LLM）。' },
        description: { type: 'string', description: '可選；省略則用 goal 當簡述' },
      },
      required: ['name', 'goal', 'body', 'verify'],
    },
    execute: async (_id, { name, goal, body, verify, script, description }) => {
      const nm = slug(name);
      if (!nm) return txt({ error: 'name 不合法（需含中英數）' });
      if (!goal || !String(goal).trim()) return txt({ error: '缺 goal：每個技能必須有明確目標' });
      if (!body || !String(body).trim()) return txt({ error: 'body 不可為空' });
      if (!verify || !String(verify).trim()) return txt({ error: '缺 verify：必須提供可驗證有效的指令（測試完成才能新增）' });
      if (typeof verifyRunner !== 'function') return txt({ error: '此環境不支援技能驗證，無法新增（須在 kernel 內執行）' });

      const vr = await verifyRunner(String(verify).trim());
      if (vr.blocked) return txt({ error: '驗證被安全策略擋下，未新增', reason: vr.reason, verify });
      if (!vr.ok) return txt({ error: '驗證未通過，未新增技能。請修正步驟或指令後重試。', exitCode: vr.code, output: vr.output, verify });

      const now = new Date().toISOString();
      const desc = (String(description || goal)).replace(/\s+/g, ' ').trim().slice(0, 120);
      const hasScript = script && String(script).trim();
      const content =
        `---\ndescription: ${desc}\ngoal: ${String(goal).replace(/\s+/g, ' ').trim()}\nverified: true\nverifiedAt: ${now}${hasScript ? '\nexecutable: true' : ''}\n---\n\n` +
        `## 目標\n${String(goal).trim()}\n\n${String(body).trim()}\n\n## 驗證（已通過 exit 0）\n\`\`\`sh\n${String(verify).trim()}\n\`\`\`\n` +
        (hasScript ? `\n## 腳本（可執行）\n\`\`\`sh\n${String(script).trim()}\n\`\`\`\n` : '');
      try {
        mkdirSync(dir, { recursive: true });
        const existed = existsSync(fileOf(nm));
        writeFileSync(fileOf(nm), content);
        skills = readAll();
        return txt({ [existed ? 'updated' : 'saved']: nm, verified: true, executable: !!hasScript, verifyOutput: vr.output, hint: `驗證通過,已結晶為技能${hasScript ? '（含可執行腳本，可用 skill_run 直接重跑）' : ''}；本 session 可用 skill 按名載入。` });
      } catch (e) { return txt({ error: e.message }); }
    },
  };

  // 漂移偵測（B）：重跑每個技能存的 verify → 標 ✓ 仍有效 / ✗ 已失效(stale)。
  const check = async () => {
    const now = new Date().toISOString();
    const results = [];
    for (const s of readAll()) {
      const verify = extractVerify(s.body);
      if (!verify) { results.push({ name: s.name, status: 'no-verify' }); continue; }
      if (typeof verifyRunner !== 'function') { results.push({ name: s.name, status: 'unchecked' }); continue; }
      const vr = await verifyRunner(verify);
      const ok = vr.ok && !vr.blocked;
      patch(s.name, ok ? { stale: 'false', lastCheckedAt: now } : { stale: 'true', staleSince: now });
      results.push({ name: s.name, status: vr.blocked ? 'blocked' : ok ? 'ok' : 'stale', exitCode: vr.code });
    }
    skills = readAll();
    return results;
  };
  const checkTool = {
    name: 'skills_check', label: '複查技能', readOnly: true,
    description: '重新驗證所有已結晶技能（重跑各自的 verify），回報哪些仍有效、哪些已失效(stale)。專案變動後用來清理過時技能,避免誤用。',
    parameters: { type: 'object', properties: {} },
    execute: async () => txt({ checked: await check() }),
  };

  // ④ 交付「能力」：直接執行含腳本技能的腳本（確定性重跑，免 LLM）。經 verifyRunner 的
  // 安全檢查＋沙箱（危險指令擋、開沙箱則 Seatbelt 包）。mutating → 走 kernel 權限步驟。
  const runSkillTool = {
    name: 'skill_run', label: '執行技能', mutating: true,
    description: '直接執行某個「含腳本」技能的腳本（確定性重跑、免 LLM 重推步驟）。技能須在 skill_save 時附 script。腳本會經安全檢查與沙箱執行；危險指令會被擋。回 exit code 與輸出。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '要執行的技能名' } }, required: ['name'] },
    execute: async (_id, { name }) => {
      if (typeof verifyRunner !== 'function') return txt({ error: '此環境不支援執行技能腳本（須在 kernel 內）' });
      const cur = readAll();
      const s = cur.find((x) => x.name === name) || cur.find((x) => x.name === slug(name));
      if (!s) return txt({ error: '找不到技能', name, available: cur.map((x) => x.name) });
      const script = extractScript(s.body);
      if (!script) return txt({ error: '此技能沒有可執行腳本（skill_save 時未附 script）', name: s.name });
      patch(s.name, { usedCount: (s.used || 0) + 1, lastUsedAt: new Date().toISOString() });
      skills = readAll();
      const r = await verifyRunner(script);
      if (r.blocked) return txt({ error: '腳本被安全策略擋下，未執行', reason: r.reason, name: s.name });
      return txt({ ran: s.name, ok: !!r.ok, exitCode: r.code, output: r.output });
    },
  };

  const remove = (name) => {
    const nm = slug(name); const file = fileOf(nm);
    if (!existsSync(file)) return { error: '找不到技能', name };
    try { unlinkSync(file); skills = readAll(); return { removed: nm }; } catch (e) { return { error: e.message }; }
  };

  // 讀單一技能完整 markdown（供 UI「查看內容」）；name 經 slug 化防穿越。
  const read = (name) => {
    const file = fileOf(slug(name));
    if (!existsSync(file)) return null;
    try { return readFileSync(file, 'utf8'); } catch { return null; }
  };

  return {
    skills, promptSection,
    tool: loadTool,
    tools: [loadTool, saveTool, checkTool, runSkillTool],
    list: () => readAll().map(({ name, desc, used, stale }) => ({ name, desc, used, stale })),
    check, remove, read,
    reload: () => { skills = readAll(); return skills; },
  };
}
