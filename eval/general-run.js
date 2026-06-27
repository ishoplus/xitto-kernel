// 通用 agent EvalSuite（GAIA 風格）—— 用共用 framework。
// node eval/general-run.js
import { loadModel } from '../src/app/providers.js';
import { createGeneralPack } from '../src/packs/general/index.js';
import { runSuite, answerMatch, stateCheck } from './framework.js';

const tasks = [
  { id: 'math（bash）', goal: '計算 1 到 100 的整數總和，可用 bash 跑程式驗算。最後只回答那個數字。', score: answerMatch('5050') },
  { id: 'file（檔案）', goal: '在工作目錄建一個 data.json，內容是 {"ok": true}。建好後讀回確認。', score: stateCheck('test -f data.json && grep -q ok data.json') },
  { id: 'api（http）', goal: '用 http 工具呼叫 https://api.github.com/repos/ishoplus/xitto-kernel（headers 帶 user-agent: xitto），回答這個 repo 的主要程式語言（language 欄位）。只回答語言名稱。', score: answerMatch('JavaScript') },
  { id: 'web（web_search）', goal: '用 web_search 查 Model Context Protocol（MCP）是哪一家公司提出的。只回答公司名稱。', score: answerMatch('Anthropic') },
];

const { model, getApiKey } = loadModel();
await runSuite({ name: 'xitto-kernel · 通用 agent（GAIA 風格）', pack: (dir) => createGeneralPack({ cwd: dir }), tasks, model, getApiKey, sandbox: false });
process.exit(0);
