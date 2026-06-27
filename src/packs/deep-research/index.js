// deep-research pack — 深度研究 agent：拆問題 → 多來源搜尋 → 讀全文查證 → 有引用的結論。
// 工具：web_search/web_fetch（共用）+ write/read（存/讀報告）。搭配 kernel 的 spawn_agent 可並行子研究。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createWebSearchTool, createWebFetchTool } from '../shared/web-tools.js';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是深度研究 agent。給你一個問題，做法：',
  '- 把問題拆成幾個子查詢，用 web_search 找多個來源（不要只查一次）。',
  '- 用 web_fetch 讀來源全文查證，不只看搜尋摘要。',
  '- 交叉比對多個來源；關鍵事實要標注來源 URL。',
  '- 最後給有引用的結論（重要論點附 [來源: URL]）；可用 write 存成報告檔。',
  '- 來源衝突或查不到時明說，不杜撰。',
].join('\n');

export function createDeepResearchPack({ cwd = process.cwd() } = {}) {
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));

  const writeReport = {
    name: 'write', label: '存報告', mutating: true, description: '把研究報告/筆記寫入檔案（建立或覆寫）。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async (_id, { path, content }) => { writeFileSync(abs(path), content ?? '', 'utf8'); return txt({ written: path, bytes: Buffer.byteLength(content ?? '') }); },
  };
  const readTool = {
    name: 'read', label: '讀檔', readOnly: true, description: '讀回已存的報告/筆記',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (_id, { path }) => { const p = abs(path); return existsSync(p) ? txt(readFileSync(p, 'utf8')) : txt({ error: '檔案不存在', path }); },
  };

  return {
    name: 'deep-research',
    tools: () => [createWebSearchTool(), createWebFetchTool(), writeReport, readTool],
    systemPrompt: SYSTEM_PROMPT,
    contextFiles: ['RESEARCH.md'],
    permissionPolicy: { defaultMode: 'default' },
  };
}

export const deepResearchPack = createDeepResearchPack();
