// devops/SRE pack — 維運自動化 agent。shell 為主 + 後台服務 + 設定檔 + 日誌搜尋 + 健康檢查。
// 工具全由共用模組組成（fs-tools / code-nav / web-tools / bg）。
import { withBaseRules } from '../shared/prompt.js';
import { createFsTools } from '../shared/fs-tools.js';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';
import { createHttpTool } from '../shared/web-tools.js';
import { createBackgroundTools } from '../../kernel/bg.js';

const SYSTEM_PROMPT = [
  '你是 DevOps/SRE agent，做系統維運與自動化。準則：',
  '- 改動前先看現況（read 設定、bash 查狀態、grep 日誌），不要盲改。',
  '- 操作盡量「冪等」（重跑不會壞）；寫腳本記得處理錯誤與權限。',
  '- 長時間/常駐服務（dev server、watch、daemon）用 bash_bg，再用 bash_output 看輸出。',
  '- 部署/操作後用 http 或命令做健康檢查，確認真的好了。',
  '- 對正式環境的破壞性操作（刪資料、重啟服務）先確認。',
].join('\n');

export function createDevopsPack({ cwd = process.cwd() } = {}) {
  const fs = createFsTools(cwd);
  const bg = createBackgroundTools(cwd);
  return {
    name: 'devops',
    tools: () => [fs.read, fs.ls, createGlobTool(cwd), createGrepTool(cwd), fs.write, fs.edit, fs.bash, ...bg.tools, createHttpTool()],
    systemPrompt: withBaseRules(SYSTEM_PROMPT),
    contextFiles: ['RUNBOOK.md', 'AGENTS.md'],
    preToolPolicy: { check: fs.readBeforeEdit },
    permissionPolicy: { defaultMode: 'default' },
  };
}

export const devopsPack = createDevopsPack();
