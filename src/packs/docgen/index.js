// docgen pack — 把產出變「可交付成品」：產 PDF / HTML 文件（中文支援）。
// 與 doc-extract 對稱：那個「讀」Office/PDF，這個「產」文件。核心在 shared/doc-gen.js。
import { withBaseRules } from '../shared/prompt.js';
import { mkdirSync } from 'node:fs';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { createFsTools } from '../shared/fs-tools.js';
import { createGrepTool, createGlobTool } from '../shared/code-nav.js';
import { runArtifactQualityPipeline } from '../shared/artifact-quality.js';
import { writeArtifactMetadata } from '../shared/artifact-metadata.js';
import { generateDoc, isValidDoc, officeCapabilities } from '../shared/doc-gen.js';
import { analyzePptxTemplate, generatePptxFromTemplate, preparePptxSlidesForDesign, validatePptxTemplateOutput } from '../shared/pptx-template.js';

const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });

const SYSTEM_PROMPT = [
  '你是文件產出助手：把使用者要的內容做成排版整齊、可直接交付的文件。準則：',
  '- 先用 read / ls / grep / glob 蒐集素材，不要憑空編造。',
  '- 可先用 office_capabilities 檢查目前環境能產哪些 Office/PDF 格式。',
  '- 若使用者提供 PPTX 模板或要求沿用母版/版式，先用 analyze_pptx_template 解析 masters/layouts/placeholders/theme，再規劃內容。',
  '- 模板化簡報可用 generate_pptx_from_template；支援逐頁智能選 layout、title/body/picture/table/chart placeholder，圖片用 slides[].images 指定且預設 contain 保持比例，表格用 slides[].tables 指定，圖表用 slides[].charts 指定；工具會先做 deterministic 設計修正（長標題縮短、長正文拆頁），正文、單表格或單圖表過多會自動拆頁，生成後檢查回傳 verify.ok、verify.design.score/issues 與 quality.ok/grade/timingsMs，必要時再用 validate_pptx_template_output 單獨驗證。',
  '- 用 gen_doc 產出成品：path 設 .pdf（PDF）、.docx（Word，原生生成）、.pptx（無模板簡報，會先把 markdown 轉成受控 deck spec，再套內建商務版型、自動拆長 bullet/長表格）、.xlsx（真正 Excel workbook；每個 GFM 表格一張工作表）、.csv（取第一個表格）或 .html；支援中文；PDF 缺工具會自動產同名 .html 並提示。',
  '- 內容用 markdown（標題 # / 清單 - / 表格 | / 引言 > / code）；結構清楚、標題分層。',
  '- 交付前確認 gen_doc 回傳 ok，且 format/path 與預期一致；若退回 HTML，告知使用者原因與如何取得 PDF。',
].join('\n');

// gen_doc：產文件並記下產出路徑（供 verify 徽章驗證）。
function genDocTool(cwd, produced) {
  return {
    name: 'gen_doc', label: '產生文件', mutating: true,
    description: '把 markdown 內容產成可交付文件並寫到 path（中文支援）。副檔名決定格式：.pdf（需 chrome / wkhtmltopdf / soffice）、.docx（原生 Word；失敗時 fallback pandoc/soffice）、.pptx（無模板原生簡報；先轉受控 deck spec，再套內建商務版型，自動拆長 bullet/長表格，失敗時 fallback soffice）、.xlsx（零相依，真正 Excel workbook；每個 GFM 表格一張工作表）、.csv（零相依，取 markdown 第一個表格，Excel 可開）、其餘 → HTML。PDF 缺對應工具時自動改產同名 .html 並回報。回傳 { ok, format, path, bytes, slides?, tool?, note? }。',
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
        const pipeline = await runArtifactQualityPipeline({
          artifact: 'document',
          input: String(markdown || ''),
          generate: (md) => generateDoc(md, abs, { title }),
          verify: verifyGeneratedDoc,
        });
        const r = { ...pipeline.result, verify: pipeline.result?.verify || pipeline.verification, quality: pipeline.quality };
        if (r.ok && r.path) produced.add(r.path); // 記下實際產出路徑（含 fallback 的 .html）供驗收
        if (r.ok && r.path) writeArtifactMetadata(cwd, r.path, artifactMetadataFor(r, 'document'));
        return txt(r);
      } catch (e) { return txt({ error: e?.message || String(e), path }); }
    },
  };
}

function officeCapabilitiesTool() {
  return {
    name: 'office_capabilities', label: 'Office 能力', mutating: false,
    description: '檢查目前環境對 Office/PDF 文件的讀寫能力與可用轉檔工具。回傳 read/write/tools 能力矩陣；產 Word/PDF/PPTX 前可先查。',
    parameters: { type: 'object', properties: {} },
    execute: async () => txt(officeCapabilities()),
  };
}

function analyzePptxTemplateTool(cwd) {
  return {
    name: 'analyze_pptx_template', label: '分析 PPT 模板', mutating: false,
    description: '分析使用者提供的 .pptx 模板，回傳 masters/layouts/placeholders/theme manifest。用於後續依母版/版式產生符合模板格式的簡報。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PPTX 模板路徑（相對工作目錄），如 template.pptx' },
      },
      required: ['path'],
    },
    execute: async (_id, { path }) => {
      const abs = isAbsolute(path) ? path : join(cwd, path);
      try {
        return txt(analyzePptxTemplate(abs));
      } catch (e) { return txt({ error: e?.message || String(e), path }); }
    },
  };
}

function generatePptxFromTemplateTool(cwd, produced) {
  return {
    name: 'generate_pptx_from_template', label: '依模板產生 PPT', mutating: true,
    description: '用既有 .pptx 模板產生新簡報。支援沿用模板 master/layout/theme，並依每頁內容智能選擇 title-only、title/body、picture、table、chart 等 layout；圖片用 slides[].images 指定，預設 contain 保持比例；表格用 slides[].tables 指定，圖表用 slides[].charts 指定；會先自動縮短過長標題、拆分長正文，長正文、單表格與單圖表也會自動拆頁。verify 會包含結構驗證與 design 分數/風險，quality 會彙總品質、修正次數與耗時。回傳 { ok, path, slides, layout, layouts, images, tables, charts, bytes, repairs, quality, verify }。',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'PPTX 模板路徑（相對工作目錄），如 template.pptx' },
        path: { type: 'string', description: '輸出 PPTX 路徑（相對工作目錄），如 output.pptx' },
        slides: {
          type: 'array',
          description: '投影片內容陣列',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              body: { type: 'array', items: { type: 'string' } },
              images: {
                type: 'array',
                description: '可選；要嵌入這張投影片的圖片。可傳路徑字串，或 { path, fit }；fit 預設 contain 保持比例，也可用 cover。',
                items: {
                  oneOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: {
                        path: { type: 'string' },
                        fit: { type: 'string', description: 'contain 或 cover；預設 contain' },
                      },
                      required: ['path'],
                    },
                  ],
                },
              },
              tables: {
                type: 'array',
                description: '可選；要嵌入這張投影片的表格。可傳多個 { name, rows }，rows 是二維陣列。',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                  },
                  required: ['rows'],
                },
              },
              charts: {
                type: 'array',
                description: '可選；要嵌入這張投影片的圖表。支援原生 bar/line/pie，可傳 { name, type, categories, values }、{ name, type, categories, series } 或 { name, type, rows }。',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', description: 'bar、line 或 pie；未指定時為 bar' },
                    categories: { type: 'array', items: { type: 'string' } },
                    values: { type: 'array', items: { type: 'number' } },
                    series: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          values: { type: 'array', items: { type: 'number' } },
                        },
                        required: ['values'],
                      },
                    },
                    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                  },
                },
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['template', 'path', 'slides'],
    },
    execute: async (_id, { template, path, slides }) => {
      const tpl = isAbsolute(template) ? template : join(cwd, template);
      const out = isAbsolute(path) ? path : join(cwd, path);
      try {
        mkdirSync(dirname(out), { recursive: true });
        const normalizedSlides = Array.isArray(slides) ? slides.map((slide) => ({
          ...slide,
          images: Array.isArray(slide.images)
            ? slide.images.map((p) => typeof p === 'string'
              ? (isAbsolute(p) ? p : join(cwd, p))
              : { ...p, path: isAbsolute(p.path) ? p.path : join(cwd, p.path) })
            : slide.images,
        })) : slides;
        const pipeline = await runArtifactQualityPipeline({
          artifact: 'pptx-template',
          input: normalizedSlides,
          prepare: (s) => {
            const prepared = preparePptxSlidesForDesign(s);
            return { input: prepared.slides, repairs: prepared.repairs };
          },
          generate: (preparedSlides) => generatePptxFromTemplate(tpl, out, preparedSlides),
        });
        const r = pipeline.result;
        r.repairs = pipeline.quality.repairs;
        r.repaired = pipeline.quality.repaired;
        r.quality = pipeline.quality;
        if (r.ok && r.path) produced.add(r.path);
        if (r.ok && r.path) writeArtifactMetadata(cwd, r.path, artifactMetadataFor(r, 'pptx-template'));
        return txt(r);
      } catch (e) { return txt({ error: e?.message || String(e), template, path }); }
    },
  };
}

function validatePptxTemplateOutputTool(cwd) {
  return {
    name: 'validate_pptx_template_output', label: '驗證模板 PPT', mutating: false,
    description: '驗證 PPTX 模板生成結果：檢查 slide XML、slide layout relationship、圖片/圖表 relationship、媒體檔、shape 位置尺寸，並回傳 design.score/issues 供判斷標題過長、正文/表格/圖表過密等版面風險。回傳 { ok, slides, images, tables, charts, layouts, design, issues }。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要驗證的 PPTX 路徑（相對工作目錄），如 output.pptx' },
      },
      required: ['path'],
    },
    execute: async (_id, { path }) => {
      const abs = isAbsolute(path) ? path : join(cwd, path);
      try {
        return txt(validatePptxTemplateOutput(abs));
      } catch (e) { return txt({ error: e?.message || String(e), path }); }
    },
  };
}

function verifyGeneratedDoc(result) {
  const issues = [];
  const designIssues = [];
  if (!result?.ok) issues.push({ level: 'error', code: 'generation-failed', message: result?.note || '文件生成失敗' });
  if (result?.ok && result?.path && !isValidDoc(result.path)) issues.push({ level: 'error', code: 'invalid-artifact', path: result.path, message: '產物無法通過格式或內容回讀驗證' });
  if (result?.format === 'html' && result?.note) designIssues.push({ level: 'warning', code: 'fallback-html', message: result.note });
  if (result?.format === 'xlsx' && result?.rows === 0) designIssues.push({ level: 'warning', code: 'empty-workbook', message: 'Excel 沒有可交付資料列' });
  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    design: {
      ok: designIssues.length === 0,
      score: Math.max(0, 100 - designIssues.length * 10 - issues.length * 50),
      issues: designIssues,
    },
  };
}

function artifactMetadataFor(result, artifact) {
  return {
    artifact,
    format: result?.format || (result?.path ? String(result.path).split('.').pop()?.toLowerCase() : undefined),
    quality: result?.quality,
    verify: result?.verify,
    repairs: result?.repairs,
    repaired: result?.repaired,
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
    tools: () => [fs.read, fs.ls, fs.write, createGrepTool(cwd), createGlobTool(cwd), officeCapabilitiesTool(), analyzePptxTemplateTool(cwd), generatePptxFromTemplateTool(cwd, produced), validatePptxTemplateOutputTool(cwd), genDocTool(cwd, produced)],
    systemPrompt: withBaseRules(SYSTEM_PROMPT),
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
