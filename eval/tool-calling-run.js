// 工具呼叫 EvalSuite（BFCL 風格）—— 測「agent 有沒有為任務選對工具、帶對參數」。
// 用 trajectory scorer（toolCalled）檢查 history，而非只看最終答案。
// node eval/tool-calling-run.js
import { loadModel } from '../src/app/providers.js';
import { createGeneralPack } from '../src/packs/general/index.js';
import { runSuite, toolCalled } from './framework.js';

const tasks = [
  { id: 'grep（搜內容）', setup: { 'a.js': '// TODO: fix\nconst x=1;\n' }, goal: '找出工作目錄裡哪些檔案含有 TODO。', score: toolCalled('grep', (a) => /todo/i.test(a.pattern || '')) },
  { id: 'glob（找檔）', setup: { 'src/x.js': '1', 'src/y.ts': '2' }, goal: '列出 src 目錄下所有 .js 檔。', score: toolCalled('glob', (a) => /\.js/.test(a.pattern || '')) },
  { id: 'web_search（搜尋）', goal: '上網查「Anthropic 公司在哪一年成立」。', score: toolCalled('web_search') },
  { id: 'http（API）', goal: '用 HTTP 請求呼叫 https://api.github.com/zen 取得一句格言。', score: toolCalled('http', (a) => /github/.test(a.url || '')) },
  { id: 'write（寫檔）', goal: '建立一個 note.txt，內容寫 hello。', score: toolCalled('write', (a) => (a.path || '').includes('note')) },
  { id: 'todo（規劃）', goal: '幫我規劃一個 3 步驟的任務待辦清單：研究、實作、測試。', score: toolCalled('todo_write') },
];

const { model, getApiKey } = loadModel();
await runSuite({ name: 'xitto-kernel · 工具呼叫（BFCL 風格）', pack: (dir) => createGeneralPack({ cwd: dir }), tasks, model, getApiKey, sandbox: false, maxRounds: 3 });
process.exit(0);
