// docgen pack — 把產出變「可交付成品」：產 PDF / HTML 文件（中文支援）。
// 與 doc-extract 對稱：那個「讀」Office/PDF，這個「產」文件。核心在 shared/doc-gen.js。
import { mkdirSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { createFsTools } from '../shared/fs-tools.js';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';
import { generateDoc } from '../shared/doc-gen.js';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是文件產出助手：把使用者要的內容做成排版整齊、可直接交付的文件。準則：',
  '- 先用 read / ls / grep / glob 蒐集素材，不要憑空編造。',
  '- 用 gen_doc 產出成品：要 PDF 就把 path 設成 .pdf（會用系統渲染器轉，支援中文；環境若無渲染器會自動產同名 .html 並提示）；其他副檔名產 HTML。',
  '- 內容用 markdown（標題 # / 清單 - / 表格 | / 引言 > / code）；結構清楚、標題分層。',
  '- 交付前確認 gen_doc 回傳 ok，且 format/path 與預期一致；若退回 HTML，告知使用者原因與如何取得 PDF。',
].join('\n');

function genDocTool(cwd) {
  return {
    name: 'gen_doc', label: '產生文件', mutating: true,
    description: '把 markdown 內容產成可交付文件並寫到 path。path 以 .pdf 結尾 → 嘗試渲染成 PDF（中文支援；需系統有 chrome / wkhtmltopdf / soffice 其一，否則自動改產同名 .html 並回報）；其他副檔名 → HTML。回傳實際產出的 { ok, format, path, bytes, tool?, note? }。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '輸出檔路徑（相對工作目錄），如 report.pdf 或 report.html' },
        markdown: { type: 'string', description: '文件內容（markdown）' },
        title: { type: 'string', description: '可選；HTML <title>/文件標題' },
      },
      required: ['path', 'markdown'],
    },
    execute: async (_id, { path, markdown, title }) => {
      const abs = isAbsolute(path) ? path : join(cwd, path);
      try {
        mkdirSync(dirname(abs), { recursive: true });
        return txt(generateDoc(String(markdown || ''), abs, { title }));
      } catch (e) { return txt({ error: e?.message || String(e), path }); }
    },
  };
}

/**
 * @param {{ cwd?: string }} [opts]
 * @returns {import('../../types.js').DomainPack}
 */
export function createDocgenPack({ cwd = process.cwd() } = {}) {
  const fs = createFsTools(cwd);
  return {
    name: 'docgen',
    tools: () => [fs.read, fs.ls, fs.write, createGrepTool(cwd), createGlobTool(cwd), genDocTool(cwd)],
    systemPrompt: SYSTEM_PROMPT,
    contextFiles: ['DOCGEN.md'],
    // mutatingTools 省略 → 從 metadata 推導（write / edit? fs.edit 未列入；gen_doc 為 mutating）
  };
}

export const docgenPack = createDocgenPack();
