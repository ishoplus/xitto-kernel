// devops agent EvalSuite —— state-check：給維運任務 → agent 操作 → 檢查結果系統/檔案狀態。
// node eval/devops-run.js
import { loadModel } from '../src/app/providers.js';
import { createDevopsPack } from '../src/packs/devops/index.js';
import { runSuite, stateCheck } from './framework.js';

const tasks = [
  {
    id: 'log-count（grep/寫檔）',
    setup: { 'app.log': 'INFO start\nERROR disk full\nINFO ok\nERROR timeout\nWARN slow\n' },
    goal: '統計 app.log 裡有幾行含 ERROR，把那個數字（只有數字）寫進 error_count.txt。',
    score: stateCheck('test "$(cat error_count.txt)" = "2"'),
  },
  {
    id: 'script（建可執行腳本）',
    goal: '建立一個 hello.sh，內容是印出 "deploy ok" 的 bash 腳本，並設成可執行（chmod +x）。',
    score: stateCheck('test -x hello.sh && ./hello.sh | grep -q "deploy ok"'),
  },
  {
    id: 'fix-script（修語法）',
    setup: { 'run.sh': '#!/bin/bash\nif [ 1 -eq 1 ]\n  echo yes\nfi\n' },
    goal: 'run.sh 有語法錯誤（if 少了 then），請修正讓 bash run.sh 能正常執行並印出 yes。',
    score: stateCheck('bash run.sh | grep -q yes'),
  },
  {
    id: 'config（產生設定）',
    goal: '產生一個 config.json，內容包含 {"port": 8080, "env": "prod"}（合法 JSON）。',
    score: stateCheck('node -e "const c=require(\'./config.json\'); process.exit(c.port===8080&&c.env===\'prod\'?0:1)"'),
  },
];

const { model, getApiKey } = loadModel();
await runSuite({ name: 'xitto-kernel · devops agent', pack: (dir) => createDevopsPack({ cwd: dir }), tasks, model, getApiKey, sandbox: false, maxRounds: 5 });
process.exit(0);
