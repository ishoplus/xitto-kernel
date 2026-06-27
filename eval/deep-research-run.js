// deep-research agent EvalSuite —— 評「事實正確 + 有真的查證」。
// 用 allOf(answerMatch 事實, toolCalled 真的讀了來源)。需網路。
// node eval/deep-research-run.js
import { loadModel } from '../src/app/providers.js';
import { createDeepResearchPack } from '../src/packs/deep-research/index.js';
import { runSuite, answerMatch, toolCalled, allOf } from './framework.js';

const tasks = [
  { id: 'mcp-by-whom', goal: '研究：Model Context Protocol（MCP）是哪一家公司提出的、用來解決什麼問題？給簡短結論。', score: allOf(answerMatch('Anthropic'), toolCalled('web_fetch')) },
  { id: 'anthropic-year', goal: '查 Anthropic 公司是哪一年成立的？附來源。', score: allOf(answerMatch('2021'), toolCalled('web_search')) },
  { id: 'node-lts', goal: '研究 Node.js 的版本發佈節奏：偶數版號的特性是什麼（LTS）？簡短說明並附來源。', score: allOf(answerMatch('LTS'), toolCalled('web_fetch')) },
];

const { model, getApiKey } = loadModel();
await runSuite({ name: 'xitto-kernel · deep-research agent', pack: (dir) => createDeepResearchPack({ cwd: dir }), tasks, model, getApiKey, sandbox: false, maxRounds: 6 });
process.exit(0);
