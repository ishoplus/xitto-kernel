// docgen pack — 把產出變「可交付成品」：產 PDF / HTML 文件（中文支援）。
// 與 doc-extract 對稱：那個「讀」Office/PDF，這個「產」文件。核心在 shared/doc-gen.js。
import { mkdirSync } from 'node:fs';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { createFsTools } from '../shared/fs-tools.js';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';
import { generateDoc, isValidDoc } from '../shared/doc-gen.js';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是文件產出助手：把使用者要的內容做成排版整齊、可直接交付的文件。準則：',
  '- 先用 read / ls / grep / glob 蒐集素材，不要憑空編造。',
  '- 用 gen_doc 產出成品：path 設 .pdf（PDF）、.docx（Word）、.pptx（簡報，每個 # 標題自動分頁，適合每頁一個重點）、.csv（資料表，Excel 可開，請用 GFM 表格）或 .html；支援中文；PDF/DOCX/PPTX 缺工具會自動產同名 .html 並提示。',
  '- 內容用 markdown（標題 # / 清單 - / 表格 | / 引言 > / code）；結構清楚、標題分層。',
  '- 交付前確認 gen_doc 回傳 ok，且 format/path 與預期一致；若退回 HTML，告知使用者原因與如何取得 PDF。',
].join('\n');

// gen_doc：產文件並記下產出路徑（供 verify 徽章驗證）。
function genDocTool(cwd, produced) {
  return {
    name: 'gen_doc', label: '產生文件', mutating: true,
    description: '把 markdown 內容產成可交付文件並寫到 path（中文支援）。副檔名決定格式：.pdf（需 chrome / wkhtmltopdf / soffice）、.docx（需 pandoc / soffice）、.pptx（簡報，需 soffice；每個 # 標題一頁）、.csv（零相依，取 markdown 第一個表格，Excel 可開）、其餘 → HTML。PDF/DOCX/PPTX 缺對應工具時自動改產同名 .html 並回報。回傳 { ok, format, path, bytes, tool?, note? }。',
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
        const r = generateDoc(String(markdown || ''), abs, { title });
        if (r.ok && r.path) produced.add(r.path); // 記下實際產出路徑（含 fallback 的 .html）供驗收
        return txt(r);
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
  const produced = new Set(); // 本 session gen_doc 實際產出的檔案路徑
  return {
    name: 'docgen',
    tools: () => [fs.read, fs.ls, fs.write, createGrepTool(cwd), createGlobTool(cwd), genDocTool(cwd, produced)],
    systemPrompt: SYSTEM_PROMPT,
    contextFiles: ['DOCGEN.md'],
    // 完成定義（verify 徽章）：產出的文件須有效（PDF=%PDF / DOCX=ZIP / HTML=有標籤 / 其餘非空）。
    verify: {
      shouldRun: ({ turnModified }) => turnModified && produced.size > 0,
      run: async () => {
        const files = [...produced];
        const bad = files.filter((p) => !isValidDoc(p));
        if (bad.length) return { ok: false, output: `${bad.length}/${files.length} 份文件無效：${bad.map((b) => basename(b)).join(', ')}` };
        const fmts = [...new Set(files.map((p) => (p.split('.').pop() || '').toLowerCase()))].join('/');
        return { ok: true, output: `${files.length} 份文件皆有效（${fmts}）：${files.map((p) => basename(p)).join(', ')}` };
      },
    },
  };
}

export const docgenPack = createDocgenPack();
