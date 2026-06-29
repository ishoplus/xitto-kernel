// patent pack — 專利交底書助手 agent。
// 從「與使用者的討論」或「進行中的專案(程式碼/文件)」挖掘可專利題目，
// 依使用者習慣與交底書格式(可用 PATENT.md 覆蓋預設章節)，在符合領域專業下協助完成交底書。
// 工具：read/ls/write/edit(共用 fs)+ grep/glob(挖專案創新點)+ web_search/web_fetch(現有技術檢索)。
// 不臆造技術細節——不確定就用 ask 問使用者(kernel 注入)；verify 守門交底書必備章節是否齊全。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createFsTools } from '../shared/fs-tools.js';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';
import { createWebSearchTool, createWebFetchTool } from '../shared/web-tools.js';

// 交底書必備章節 = 使用者固定 5 段式格式(關鍵字命中即視為存在)。
// PATENT.md 可覆蓋 system prompt 的格式，但 verify 仍以這 5 段為底線守門(缺則回灌補齊)。
const CORE_SECTIONS = [
  { key: '1. 現有技術及其問題', re: /現有技[術术]|现有技术|背景技[術术]|prior\s*art/i },
  { key: '2. 技術方案', re: /技[術术]方案|解[決决]現有|解决现有|technical\s*solution/i },
  { key: '3. 意想不到的效果', re: /意想不到|有別於現有|有别于现有|意外效果|unexpected\s*effect/i },
  { key: '4. 技術重點', re: /技[術术]重[點点]|技[術术]特[徵征].*重點|key\s*(technical\s*)?point/i },
  { key: '5. 技術特徵的檢索式', re: /檢索式|检索式|檢索條件|检索条件|search\s*(string|query|expression)/i },
];

const SYSTEM_PROMPT = [
  '你是資深專利工程師／專利代理人助手，協助使用者完成「專利交底書」(invention disclosure)。主要領域：半導體、智能體(AI agent)。',
  '',
  '【固定交底書格式 — 嚴格依此 5 段(除非 PATENT.md 另有指定)】',
  '產出 markdown，先寫「發明名稱」，再依序填以下 5 段標題(原文照用)：',
  '  發明名稱：<簡潔、能涵蓋技術重點，避免商業用語>',
  '  1. 請描述現有技術及其存在的問題',
  '     —— 寫清楚目前業界/既有作法是什麼、出處(可附檢索到的來源)、有哪些具體缺點或未解決的痛點。',
  '  2. 解決現有問題的技術方案是什麼？',
  '     —— 本發明的核心技術手段，講清「怎麼做」。要具體到可據以實施(他人能重現)，可分步驟/模組/實施例；半導體類給結構/製程/參數，智能體類給架構/資料流/演算法流程。',
  '  3. 有別於現有技術之意想不到的效果是什麼？',
  '     —— 相對現有技術的差異點與「非顯而易見」的有益效果(效能/良率/成本/準確率/延遲等，盡量量化)；這段是創造性(進步性)的關鍵。',
  '  4. 本發明的技術重點是什麼？',
  '     —— 條列必要技術特徵(申請專利範圍的雛形)：哪些特徵組合才構成本發明、哪些是核心不可省、哪些是較佳實施例。',
  '  5. 技術特徵的檢索式',
  '     —— 由步驟 4 的技術特徵萃取關鍵字，組成可用於專利資料庫的檢索式：中英文關鍵字 + 同義詞，以 AND/OR 布林邏輯組合，可附 IPC/CPC 分類號建議。給 1~3 條由寬到窄的檢索式，並可用 web_search 試跑驗證能撈到相關現有技術。',
  '',
  '【領域撰寫要點】',
  '- 半導體：聚焦結構/製程步驟/材料/摻雜/關鍵尺寸與參數範圍/器件或電路;實施例給具體工藝條件與結構描述,效果盡量用良率/漏電/功耗/速度等量化。',
  '- 智能體(AI agent)：聚焦系統架構/模組與工具編排/資料流與狀態管理/提示或決策策略/演算法步驟;務必把發明落到「以技術手段解決技術問題」(避免被視為純商業方法或抽象演算法),實施例給流程步驟、模組互動、資料結構。',
  '',
  '【找題目：從討論或進行中專案】',
  '- 從與使用者的討論、或用 grep/glob/read 探勘進行中專案的程式碼與文件，識別具「新穎性、進步性、產業利用性」的發明點。',
  '- 一次提出數個候選題目，每個附：一句話創新點、為何可能可專利、屬半導體或智能體哪個面向，讓使用者挑選，不要替使用者武斷定題。',
  '',
  '【啟動時先對齊習慣與格式】',
  '- 先讀 contextFile(PATENT.md／交底書模板)與既有 memory：若存在，依其章節結構/措辭/語言/公司背景覆蓋上述預設。',
  '',
  '【符合領域專業 + 不臆造】',
  '- 用 web_search/web_fetch 做初步現有技術檢索，交叉比對多個來源，關鍵事實標注來源 URL；明說這不是正式專利檢索(FTO/可專利性檢索)，正式檢索建議交專業機構。',
  '- 技術方案與實施例細節優先取自真實專案；任何不確定的技術細節/參數/流程，用 ask 向使用者提問補齊，寧可問也不要編造(錯誤交底書會害到後續申請)。',
  '',
  '【產出】',
  '- 用 write/edit 將交底書寫成 markdown(預設檔名 交底書_<發明名稱>.md)；改既有檔前先 read。完稿後自我檢查 5 段是否齊全、技術方案是否可實施、效果是否量化、檢索式是否能撈到現有技術。',
].join('\n');

/**
 * @param {{ cwd?: string }} [opts]
 * @returns {import('../../types.js').DomainPack}
 */
export function createPatentPack({ cwd = process.cwd() } = {}) {
  const fs = createFsTools(cwd);

  // 找出最近修改、看起來是交底書的 markdown(供 verify 檢查章節完整性)。
  const latestDisclosure = () => {
    let best = null;
    try {
      for (const f of readdirSync(cwd)) {
        if (!f.endsWith('.md')) continue;
        if (!/交底|disclosure|patent|專利|专利/i.test(f)) continue;
        const p = join(cwd, f);
        try { const m = statSync(p).mtimeMs; if (!best || m > best.m) best = { p, m, f }; } catch { /* 略 */ }
      }
    } catch { /* 略 */ }
    return best;
  };

  return {
    name: 'patent',
    tools: () => [
      fs.read, fs.ls,
      createGlobTool(cwd), createGrepTool(cwd),   // 探勘進行中專案，挖創新點 / 取實施細節
      createWebSearchTool(), createWebFetchTool(), // 現有技術初步檢索
      fs.write, fs.edit,                           // 產出 / 修訂交底書
    ],
    systemPrompt: SYSTEM_PROMPT,
    contextFiles: ['PATENT.md', '交底書模板.md', 'CLAUDE.md'], // 使用者習慣與格式注入點(找到即注入 system prompt)
    // mutatingTools 省略 → kernel 從 write/edit 的 metadata 推導
    verify: {
      // 本輪有改動且存在交底書檔時，檢查核心章節是否齊全；缺則回灌一次讓 agent 補。
      shouldRun: (ctx) => ctx.turnModified && !!latestDisclosure(),
      run: async () => {
        const d = latestDisclosure();
        if (!d) return { ok: true };
        let body = '';
        try { body = readFileSync(d.p, 'utf8'); } catch { return { ok: true }; }
        const missing = CORE_SECTIONS.filter((s) => !s.re.test(body)).map((s) => s.key);
        if (!missing.length) return { ok: true };
        return { ok: false, output: `交底書「${d.f}」缺少必備段落：${missing.join('、')}。請補齊 5 段(現有技術及問題 / 技術方案 / 意想不到的效果 / 技術重點 / 技術特徵的檢索式)；若使用者 PATENT.md 另有格式，依其模板。` };
      },
      maxRounds: 1,
    },
    preToolPolicy: {
      // read-before-edit：改既有交底書/模板前先讀當前內容，避免覆蓋掉使用者既有版本。
      check: (ctx) => fs.readBeforeEdit(ctx),
    },
    permissionPolicy: { sandbox: { enabled: false }, defaultMode: 'default' }, // 文檔產出，寫檔預設仍向使用者確認
    memoryGuide: '把「使用者的交底書格式偏好、慣用措辭、所屬公司、主領域(半導體/智能體)、常用技術棧」存進 memory；把「本專案的可專利點清單、已申請/已揭露清單、慣用 IPC/CPC 分類」用 playbook 記錄(同 topic 覆蓋)，下次自動載入不必重新摸索。',
  };
}

export const patentPack = createPatentPack();
