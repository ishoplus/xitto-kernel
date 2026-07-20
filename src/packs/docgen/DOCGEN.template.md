# DOCGEN.md

## Office generation contract

- Treat the LLM as content planner only. Provide markdown, semantic headings, tables, image paths, and chart data; do not invent shape syntax, manual coordinates, or absolute positioning.
- For template PPTX, first use `analyze_pptx_template`, then `generate_pptx_from_template`, and check `verify.ok`, `verify.design.ok`, and `quality.ok`.
- For no-template PPTX, use `plan_pptx_deck` before complex decks. The plan must have no blocking warnings before `gen_doc` is considered deliverable.
- If `plan_pptx_deck` returns `unsupported-diagram-heading`, do not draw the requested diagram manually. Use a supported diagram from `contract.supportedDiagrams`, explain the limitation, or implement a deterministic renderer with docs and tests.
- After `gen_doc`, inspect `format`, `path`, `quality.grade`, `verify.ok`, and `verify.design.issues`. A generated file with `quality.grade: "needs-repair"` is not finished.
- For Word and Excel, prefer native `.docx` / `.xlsx` outputs when available, and verify the artifact can be read back by the Office extractor.

## PPT headings supported by the controlled renderer

Use level-2 markdown headings to request built-in business diagrams:

- `流程圖`
- `魚骨圖`
- `比較矩陣`
- `時間線`
- `循環圖`
- `漏斗圖`
- `金字塔`
- `SWOT`
- `KPI 看板`
- `組織架構圖`
- `甘特圖`
- `Venn`
- `能力雷達`
- `系統架構圖`

## Done means

- The file exists at the requested path.
- The generator reports `ok: true`.
- `quality.ok` is true and `quality.grade` is `pass`.
- `verify.ok` is true.
- For PPTX, `verify.design.ok` is true.
- Any fallback to HTML, unsupported diagram warning, dense slide warning, invalid artifact, or readback failure must be reported and repaired before calling the result complete.
