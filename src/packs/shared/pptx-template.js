import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export function analyzePptxTemplate(path) {
  if (extname(String(path)).toLowerCase() !== '.pptx') throw new Error('只支援 .pptx 模板');
  const zip = readZip(readFileSync(path));
  const presentation = zip.read('ppt/presentation.xml') || '';
  const presRels = relsMap(zip.read('ppt/_rels/presentation.xml.rels') || '', 'ppt/presentation.xml');
  const slideSize = parseSlideSize(presentation);
  const masterPaths = [...presRels.values()].filter((r) => /\/slideMaster$/.test(r.type)).map((r) => r.path).filter((p) => zip.read(p) != null);
  const layouts = [];
  const themePaths = new Set();

  masterPaths.forEach((masterPath, masterIndex) => {
    const masterRelsPath = relPath(masterPath);
    const masterRels = relsMap(zip.read(masterRelsPath) || '', masterPath);
    for (const rel of masterRels.values()) {
      if (/\/theme$/.test(rel.type)) themePaths.add(rel.path);
      if (!/\/slideLayout$/.test(rel.type) || zip.read(rel.path) == null) continue;
      const xml = zip.read(rel.path) || '';
      layouts.push({
        index: layouts.length + 1,
        master: masterIndex + 1,
        name: decodeEntities((xml.match(/<p:sldLayout\b[^>]*\bname="([^"]*)"/) || [])[1] || `Layout ${layouts.length + 1}`),
        path: rel.path,
        placeholders: parsePlaceholders(xml),
      });
    }
  });

  const themes = [...themePaths].map((p) => parseTheme(zip.read(p) || '', p));
  return {
    kind: 'pptx-template',
    path,
    slideSize,
    masters: masterPaths.length,
    layouts,
    theme: mergeThemes(themes),
    themes,
  };
}

export function preparePptxSlidesForDesign(slides = []) {
  if (!Array.isArray(slides)) return { slides, repairs: [] };
  const repairs = [];
  const out = [];
  slides.forEach((slide, slideIndex) => {
    let current = { ...slide };
    const title = String(current.title || '');
    if (textLength(title) > 28) {
      current.title = `${[...title].slice(0, 25).join('')}...`;
      repairs.push({ slide: slideIndex + 1, code: 'title-shortened', message: '標題過長，已縮短以降低換行與壓縮風險' });
    }

    const body = Array.isArray(current.body) ? current.body.map(String) : String(current.body || '').split(/\r?\n/).filter(Boolean);
    const visual = splitVisualContent(current);
    const bodyLinesPerSlide = bodyLinesLimit(body);
    if (body.length > VISUAL_BODY_LINES_PER_SLIDE && visual.hasVisuals) {
      for (let i = 0; i < body.length; i += bodyLinesPerSlide) {
        out.push({
          ...current,
          title: i === 0 ? current.title : continuationTitle(current.title, Math.floor(i / bodyLinesPerSlide) + 1),
          body: body.slice(i, i + bodyLinesPerSlide),
          images: undefined,
          tables: undefined,
          table: undefined,
          charts: undefined,
          chart: undefined,
        });
      }
      out.push({
        ...current,
        title: visualTitle(current.title),
        body: [],
        images: visual.images,
        tables: visual.tables,
        table: undefined,
        charts: visual.charts,
        chart: undefined,
      });
      repairs.push({ slide: slideIndex + 1, code: 'visual-split', message: '正文與表格/圖表同頁過密，已拆成獨立資料頁', before: body.length });
      return;
    }
    if (body.length > bodyLinesPerSlide) {
      for (let i = 0; i < body.length; i += bodyLinesPerSlide) {
        out.push({
          ...current,
          title: i === 0 ? current.title : continuationTitle(current.title, Math.floor(i / bodyLinesPerSlide) + 1),
          body: body.slice(i, i + bodyLinesPerSlide),
          images: i === 0 ? current.images : undefined,
          tables: i === 0 ? current.tables : undefined,
          table: i === 0 ? current.table : undefined,
          charts: i === 0 ? current.charts : undefined,
          chart: i === 0 ? current.chart : undefined,
        });
      }
      repairs.push({ slide: slideIndex + 1, code: 'body-split', message: `正文超過 ${BODY_LINES_PER_SLIDE} 條，已拆成續頁`, before: body.length });
      return;
    }

    out.push(current);
  });
  return { slides: out, repairs };
}

function splitVisualContent(slide) {
  const images = Array.isArray(slide.images) ? slide.images : slide.images ? [slide.images] : [];
  const tables = normalizeTables(slide.tables || slide.table || []);
  const charts = normalizeCharts(slide.charts || slide.chart || []);
  return { images, tables, charts, hasVisuals: images.length + tables.length + charts.length > 0 };
}

function visualTitle(title) {
  const suffix = '｜關鍵數據';
  const base = String(title || '資料圖表');
  const max = Math.max(1, 28 - textLength(suffix));
  return `${[...base].slice(0, max).join('')}${suffix}`;
}

function bodyLinesLimit(body = []) {
  const maxLine = Math.max(0, ...body.map(textLength));
  return maxLine > 30 ? 4 : BUSINESS_BODY_LINES_PER_SLIDE;
}

function continuationTitle(title, n) {
  const suffix = `（續 ${n}）`;
  const base = String(title || '投影片');
  const max = Math.max(1, 28 - textLength(suffix));
  return `${[...base].slice(0, max).join('')}${suffix}`;
}

export function generatePptxFromTemplate(templatePath, outPath, slides = []) {
  if (!Array.isArray(slides) || !slides.length) throw new Error('slides 至少要有一頁');
  slides = expandSlidesForCapacity(slides);
  const input = readZip(readFileSync(templatePath));
  const manifest = analyzePptxTemplate(templatePath);
  if (!manifest.layouts.length) throw new Error('模板找不到可用的 slide layout');

  const files = input.files();
  const existingSlides = [...files.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const existingMedia = [...files.keys()].filter((n) => /^ppt\/media\/image\d+\./.test(n));
  const existingCharts = [...files.keys()].filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  const start = Math.max(0, ...existingSlides.map((n) => +(n.match(/slide(\d+)\.xml$/) || [])[1] || 0)) + 1;
  let mediaNo = Math.max(0, ...existingMedia.map((n) => +(n.match(/image(\d+)\./) || [])[1] || 0)) + 1;
  let chartNo = Math.max(0, ...existingCharts.map((n) => +(n.match(/chart(\d+)\.xml$/) || [])[1] || 0)) + 1;
  const presRelsPath = 'ppt/_rels/presentation.xml.rels';
  const presRels = files.get(presRelsPath)?.toString('utf8') || defaultPresentationRels();
  const nextRel = nextRid(presRels);
  const imageExts = new Set();
  const slideInfos = slides.map((slide, i) => {
    const body = Array.isArray(slide.body) ? slide.body.map(String) : String(slide.body || '').split(/\r?\n/).filter(Boolean);
    const imageInputs = normalizeImages(slide.images || []);
    const tables = normalizeTables(slide.tables || slide.table || []);
    const charts = normalizeCharts(slide.charts || slide.chart || []);
    const bodyLimit = bodyLinesLimit(body);
    const layout = selectLayout(manifest, { ...slide, body, images: imageInputs, tables, charts });
    if (!layout) throw new Error(`第 ${i + 1} 張投影片找不到可用 layout`);
    const images = normalizeImages(slide.images || []).map((img, imageIndex) => {
      const data = readFileSync(img.path);
      const ext = imageExt(img.path);
      if (!ext) throw new Error(`不支援的圖片格式：${img.path}`);
      const mediaPath = `ppt/media/image${mediaNo++}.${ext}`;
      files.set(mediaPath, data);
      imageExts.add(ext);
      return {
        name: img.name || basename(img.path),
        relId: `rId${imageIndex + 2}`,
        path: mediaPath,
        target: `../media/${basename(mediaPath)}`,
        ext,
        mime: imageMimeFromExt(ext),
        fit: img.fit || 'contain',
        dimensions: imageDimensions(data, ext),
      };
    });
    const chartInfos = charts.map((chart, chartIndex) => {
      const chartPath = `ppt/charts/chart${chartNo++}.xml`;
      files.set(chartPath, Buffer.from(chartXml(chart), 'utf8'));
      return {
        name: chart.name,
        relId: `rId${images.length + chartIndex + 2}`,
        path: chartPath,
        target: `../charts/${basename(chartPath)}`,
        chart,
      };
    });
    return {
      no: start + i,
      relId: `rId${nextRel + i}`,
      title: String(slide.title || `投影片 ${i + 1}`),
      body,
      images,
      tables,
      charts: chartInfos,
      layout,
      slideSize: manifest.slideSize,
    };
  });

  for (const info of slideInfos) {
    files.set(`ppt/slides/slide${info.no}.xml`, Buffer.from(slideXml(info, info.layout), 'utf8'));
    files.set(`ppt/slides/_rels/slide${info.no}.xml.rels`, Buffer.from(slideRelsXml(info.layout.path, info.images, info.charts), 'utf8'));
  }
  files.set('ppt/presentation.xml', Buffer.from(updatePresentation(files.get('ppt/presentation.xml')?.toString('utf8') || defaultPresentationXml(), slideInfos), 'utf8'));
  files.set(presRelsPath, Buffer.from(updatePresentationRels(presRels, slideInfos), 'utf8'));
  files.set('[Content_Types].xml', Buffer.from(updateContentTypes(files.get('[Content_Types].xml')?.toString('utf8') || defaultContentTypes(), slideInfos, imageExts), 'utf8'));
  if (!files.has('_rels/.rels')) files.set('_rels/.rels', Buffer.from(rootRelsXml(), 'utf8'));

  const buf = zipStore([...files.entries()].map(([name, data]) => ({ name, data })));
  writeFileSync(outPath, buf);
  const layouts = [...new Set(slideInfos.map((s) => s.layout.name))];
  const verify = validatePptxTemplateOutput(outPath);
  return {
    ok: true,
    path: outPath,
    slides: slideInfos.length,
    layout: layouts[0] || '',
    layouts,
    images: slideInfos.reduce((n, s) => n + s.images.length, 0),
    tables: slideInfos.reduce((n, s) => n + s.tables.length, 0),
    charts: slideInfos.reduce((n, s) => n + s.charts.length, 0),
    bytes: buf.length,
    verify,
  };
}

export function validatePptxTemplateOutput(path) {
  if (extname(String(path)).toLowerCase() !== '.pptx') throw new Error('只支援 .pptx');
  const zip = readZip(readFileSync(path));
  const issues = [];
  const presentation = zip.read('ppt/presentation.xml') || '';
  const slideSize = parseSlideSize(presentation) || { cx: 9144000, cy: 5143500 };
  const slides = zip.files();
  const slidePaths = [...slides.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
  const layoutNames = new Set();
  const designSlides = [];
  let imageCount = 0;
  let tableCount = 0;
  let chartCount = 0;

  if (!slidePaths.length) issues.push({ level: 'error', message: '找不到任何 slide XML' });
  for (const slidePath of slidePaths) {
    const relsPath = relPath(slidePath);
    const slideXmlText = zip.read(slidePath) || '';
    const rels = relsMap(zip.read(relsPath) || '', slidePath);
    const layoutRel = [...rels.values()].find((r) => /\/slideLayout$/.test(r.type));
    if (!zip.read(relsPath)) issues.push({ level: 'error', slide: slidePath, message: '缺少 slide relationships' });
    if (!layoutRel) {
      issues.push({ level: 'error', slide: slidePath, message: '缺少 slide layout relationship' });
    } else if (zip.read(layoutRel.path) == null) {
      issues.push({ level: 'error', slide: slidePath, target: layoutRel.path, message: 'slide layout 目標不存在' });
    } else {
      layoutNames.add(parseLayoutName(zip.read(layoutRel.path) || '', layoutRel.path));
    }

    const relIds = new Set(rels.keys());
    for (const [, rid] of slideXmlText.matchAll(/\br:embed="([^"]+)"/g)) {
      if (!relIds.has(rid)) issues.push({ level: 'error', slide: slidePath, relId: rid, message: 'slide XML 引用不存在的 relationship' });
    }
    for (const rel of rels.values()) {
      if (/\/image$/.test(rel.type)) {
        imageCount++;
        if (zip.readBuffer(rel.path) == null) issues.push({ level: 'error', slide: slidePath, target: rel.path, message: '圖片 relationship 目標不存在' });
      }
      if (/\/chart$/.test(rel.type)) {
        chartCount++;
        if (zip.read(rel.path) == null) issues.push({ level: 'error', slide: slidePath, target: rel.path, message: '圖表 relationship 目標不存在' });
      }
    }
    const picCount = (slideXmlText.match(/<p:pic\b/g) || []).length;
    const imageRelCount = [...rels.values()].filter((r) => /\/image$/.test(r.type)).length;
    if (picCount !== imageRelCount) issues.push({ level: 'warning', slide: slidePath, message: `圖片形狀數 (${picCount}) 與圖片 relationship 數 (${imageRelCount}) 不一致` });
    tableCount += (slideXmlText.match(/<a:tbl\b/g) || []).length;
    const chartShapeCount = (slideXmlText.match(/<c:chart\b/g) || []).length;
    const chartRelCount = [...rels.values()].filter((r) => /\/chart$/.test(r.type)).length;
    if (chartShapeCount !== chartRelCount) issues.push({ level: 'warning', slide: slidePath, message: `圖表形狀數 (${chartShapeCount}) 與圖表 relationship 數 (${chartRelCount}) 不一致` });
    designSlides.push(analyzeSlideDesign(zip, slidePath, slideXmlText, rels));

    for (const box of shapeBoxes(slideXmlText)) {
      if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.cx) || !Number.isFinite(box.cy) || box.cx <= 0 || box.cy <= 0) {
        issues.push({ level: 'error', slide: slidePath, shape: box.name, message: 'shape 缺少有效位置或尺寸' });
      } else if (box.x < 0 || box.y < 0 || box.x + box.cx > slideSize.cx || box.y + box.cy > slideSize.cy) {
        issues.push({ level: 'warning', slide: slidePath, shape: box.name, message: 'shape 超出 slide 邊界' });
      }
    }
  }

  return {
    ok: !issues.some((i) => i.level === 'error'),
    slides: slidePaths.length,
    images: imageCount,
    tables: tableCount,
    charts: chartCount,
    layouts: [...layoutNames],
    design: summarizeDesign(designSlides),
    issues,
  };
}

function selectLayout(manifest, slide = {}) {
  const body = Array.isArray(slide.body) ? slide.body : String(slide.body || '').split(/\r?\n/).filter(Boolean);
  const imageCount = normalizeImages(slide.images || []).length;
  const tableCount = normalizeTables(slide.tables || slide.table || []).length;
  const chartCount = normalizeCharts(slide.charts || slide.chart || []).length;
  const titleOnly = !body.length && !imageCount && !tableCount && !chartCount;
  const scored = manifest.layouts.map((layout, index) => {
    const types = layout.placeholders.map((p) => p.type);
    const hasTitle = types.some((t) => ['title', 'ctrTitle'].includes(t));
    const hasBody = types.some((t) => ['body', 'subTitle', 'obj'].includes(t));
    const picCount = types.filter((t) => t === 'pic').length;
    const tblCount = types.filter((t) => ['tbl', 'table'].includes(t)).length;
    const phChartCount = types.filter((t) => t === 'chart').length;
    const name = layout.name.toLowerCase();
    let score = 0;
    if (hasTitle) score += 10;
    if (body.length && hasBody) score += 24;
    if (!body.length && !hasBody) score += 8;
    if (imageCount && picCount) score += 40 + Math.min(picCount, imageCount) * 8 - Math.max(0, imageCount - picCount) * 4;
    if (imageCount && !picCount) score -= 18;
    if (!imageCount && picCount) score -= 6;
    if (tableCount && tblCount) score += 42 + Math.min(tblCount, tableCount) * 8 - Math.max(0, tableCount - tblCount) * 4;
    if (tableCount && !tblCount) score -= 18;
    if (!tableCount && tblCount) score -= 6;
    if (chartCount && phChartCount) score += 44 + Math.min(phChartCount, chartCount) * 8 - Math.max(0, chartCount - phChartCount) * 4;
    if (chartCount && !phChartCount) score -= 18;
    if (!chartCount && phChartCount) score -= 6;
    if (titleOnly && /title|cover|封面|標題/.test(name)) score += 12;
    if (body.length && /content|body|text|內容|正文/.test(name)) score += 6;
    if (imageCount && /picture|image|photo|圖|圖片|照片/.test(name)) score += 8;
    if (tableCount && /table|matrix|grid|表|表格/.test(name)) score += 8;
    if (chartCount && /chart|graph|圖表|圖/.test(name)) score += 8;
    return { layout, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.layout || manifest.layouts[0];
}

function slideXml(slide, layout) {
  const auto = autoLayoutBoxes(slide);
  const boxes = resolvedLayoutBoxes(slide, layout, auto);
  const titlePh = boxes.title;
  const bodyPh = boxes.body || {};
  const body = slide.body.length ? textShape(3, 'Content 1', 'body', bodyPh.idx || '2', slide.body, bodyPh) : '';
  const pictures = slide.images.map((img, i) => pictureShape(4 + i, img, boxes.images[i] || defaultImageBox(i))).join('');
  const tables = slide.tables.map((table, i) => tableShape(4 + slide.images.length + i, table, boxes.tables[i] || defaultTableBox(i))).join('');
  const charts = slide.charts.map((chart, i) => chartShape(4 + slide.images.length + slide.tables.length + i, chart, boxes.charts[i] || defaultChartBox(i))).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${decorativeShapes(slide)}${textShape(2, 'Title 1', 'title', titlePh.idx || '1', slide.title, titlePh)}${body}${pictures}${tables}${charts}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function resolvedLayoutBoxes(slide, layout, auto) {
  const title = safeTemplateBox(slide, layout.placeholders.find((p) => ['title', 'ctrTitle'].includes(p.type))) || auto.title;
  const body = safeTemplateBox(slide, layout.placeholders.find((p) => ['body', 'subTitle', 'obj'].includes(p.type))) || auto.body;
  const images = layout.placeholders.filter((p) => p.type === 'pic').map((p) => safeTemplateBox(slide, p));
  const tables = layout.placeholders.filter((p) => ['tbl', 'table'].includes(p.type)).map((p) => safeTemplateBox(slide, p));
  const charts = layout.placeholders.filter((p) => p.type === 'chart').map((p) => safeTemplateBox(slide, p));
  const requestedVisuals = [
    ...slide.images.map((_, i) => images[i] || auto.images[i]),
    ...slide.tables.map((_, i) => tables[i] || auto.tables[i]),
    ...slide.charts.map((_, i) => charts[i] || auto.charts[i]),
  ].filter(Boolean);
  const requestedBody = slide.body.length ? body : null;
  const templateUnsafe = requestedBody && requestedVisuals.some((box) => boxesOverlap(requestedBody, box))
    || requestedVisuals.some((box, i) => requestedVisuals.slice(i + 1).some((other) => boxesOverlap(box, other)))
    || requestedVisuals.some((box) => title && boxesOverlap(title, box))
    || (requestedBody && title && boxesOverlap(title, requestedBody));

  if (!templateUnsafe) {
    return {
      title,
      body,
      images: slide.images.map((_, i) => images[i] || auto.images[i]).filter(Boolean),
      tables: slide.tables.map((_, i) => tables[i] || auto.tables[i]).filter(Boolean),
      charts: slide.charts.map((_, i) => charts[i] || auto.charts[i]).filter(Boolean),
    };
  }
  return auto;
}

function safeTemplateBox(slide, box) {
  const usable = usableBox(box);
  if (!usable) return null;
  const size = slide.slideSize || {};
  const sw = Number.isFinite(size.cx) && size.cx > 0 ? size.cx : 9144000;
  const sh = Number.isFinite(size.cy) && size.cy > 0 ? size.cy : 5143500;
  return usable.x >= 0 && usable.y >= 0 && usable.x + usable.cx <= sw && usable.y + usable.cy <= sh ? usable : null;
}

function boxesOverlap(a, b) {
  if (!a || !b) return false;
  const pad = 45720;
  return a.x + pad < b.x + b.cx && a.x + a.cx > b.x + pad && a.y + pad < b.y + b.cy && a.y + a.cy > b.y + pad;
}

function decorativeShapes(slide) {
  const size = slide.slideSize || {};
  const sw = Number.isFinite(size.cx) && size.cx > 0 ? size.cx : 9144000;
  const sh = Number.isFinite(size.cy) && size.cy > 0 ? size.cy : 5143500;
  const barW = Math.round(sw * 0.012);
  const mx = Math.round(sw * 0.05);
  const lineY = Math.round(sh * 0.205);
  return `${rectShape(910, 'Accent Bar', 0, 0, barW, sh, '1F4E79')}${rectShape(911, 'Title Rule', mx, lineY, Math.round(sw * 0.42), Math.max(22860, Math.round(sh * 0.006)), '1F4E79')}`;
}

function rectShape(id, name, x, y, cx, cy, color) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEsc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
}

function usableBox(box) {
  if (!box) return null;
  return Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.cx) && Number.isFinite(box.cy) && box.cx > 0 && box.cy > 0 ? box : null;
}

function autoLayoutBoxes(slide) {
  const size = slide.slideSize || {};
  const sw = Number.isFinite(size.cx) && size.cx > 0 ? size.cx : 9144000;
  const sh = Number.isFinite(size.cy) && size.cy > 0 ? size.cy : 5143500;
  const mx = Math.round(sw * 0.05);
  const titleY = Math.round(sh * 0.055);
  const titleH = Math.round(sh * 0.14);
  const gap = Math.round(sh * 0.035);
  const top = titleY + titleH + gap;
  const bottom = sh - Math.round(sh * 0.07);
  const contentH = Math.max(914400, bottom - top);
  const contentW = sw - mx * 2;
  const visualCount = slide.images.length + slide.tables.length + slide.charts.length;
  const bodyCount = slide.body.length;
  const boxes = {
    title: { x: mx, y: titleY, cx: contentW, cy: titleH },
    body: null,
    images: [],
    tables: [],
    charts: [],
  };

  let visualRegion = { x: mx, y: top, cx: contentW, cy: contentH };
  if (bodyCount && visualCount) {
    const bodyW = Math.round(contentW * 0.44);
    boxes.body = { x: mx, y: top, cx: bodyW, cy: contentH };
    visualRegion = { x: mx + bodyW + gap, y: top, cx: Math.max(914400, contentW - bodyW - gap), cy: contentH };
  } else if (bodyCount) {
    boxes.body = { x: mx, y: top, cx: contentW, cy: contentH };
  }

  const visualBoxes = splitRegion(visualRegion, Math.max(visualCount, 0), gap);
  let vi = 0;
  for (let i = 0; i < slide.images.length; i++) boxes.images.push(visualBoxes[vi++] || defaultImageBox(i));
  for (let i = 0; i < slide.tables.length; i++) boxes.tables.push(visualBoxes[vi++] || defaultTableBox(i));
  for (let i = 0; i < slide.charts.length; i++) boxes.charts.push(visualBoxes[vi++] || defaultChartBox(i));
  return boxes;
}

function splitRegion(region, count, gap) {
  if (!count) return [];
  if (count === 1) return [region];
  if (count === 2 && region.cx > region.cy * 1.25) {
    const w = Math.floor((region.cx - gap) / 2);
    return [
      { x: region.x, y: region.y, cx: w, cy: region.cy },
      { x: region.x + w + gap, y: region.y, cx: region.cx - w - gap, cy: region.cy },
    ];
  }
  const h = Math.max(685800, Math.floor((region.cy - gap * (count - 1)) / count));
  return Array.from({ length: count }, (_, i) => ({
    x: region.x,
    y: region.y + i * (h + gap),
    cx: region.cx,
    cy: i === count - 1 ? Math.max(457200, region.y + region.cy - (region.y + i * (h + gap))) : h,
  }));
}

function textShape(id, name, role, idx, text, ph) {
  const lines = Array.isArray(text) ? text : [text];
  const title = role === 'title';
  const fontSize = title ? 2800 : 1650;
  const color = title ? '111827' : '374151';
  const bodyPr = title ? '<a:bodyPr anchor="ctr"/>' : '<a:bodyPr anchor="t" lIns="0" tIns="0" rIns="0" bIns="0"/>';
  const paragraphs = lines.map((line) => {
    const pPr = title ? '<a:pPr algn="l"/>' : '<a:pPr marL="342900" indent="-171450"><a:buChar char="•"/></a:pPr>';
    return `<a:p>${pPr}<a:r><a:rPr lang="zh-TW" sz="${fontSize}"${title ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${title ? 'Aptos Display' : 'Aptos'}"/><a:ea typeface="Microsoft JhengHei"/></a:rPr><a:t>${xmlEsc(line)}</a:t></a:r></a:p>`;
  }).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEsc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="${role}" idx="${xmlEsc(idx)}"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${ph.x ?? 457200}" y="${ph.y ?? (role === 'title' ? 274638 : 1600200)}"/><a:ext cx="${ph.cx ?? 8229600}" cy="${ph.cy ?? (role === 'title' ? 914400 : 3600000)}"/></a:xfrm><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody>${bodyPr}<a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function pictureShape(id, img, box) {
  const fitted = fitBox(box, img.dimensions, img.fit);
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xmlEsc(img.name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><p:ph type="pic"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="${xmlEsc(img.relId)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${fitted.x}" y="${fitted.y}"/><a:ext cx="${fitted.cx}" cy="${fitted.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function defaultImageBox(i) {
  return { x: 5486400, y: 1600200 + i * 914400, cx: 3200400, cy: 1800000 };
}

function tableShape(id, table, box) {
  const fallback = defaultTableBox(0);
  const x = box.x ?? fallback.x, y = box.y ?? fallback.y, cx = box.cx ?? fallback.cx, cy = box.cy ?? fallback.cy;
  const rows = table.rows;
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const colWidth = Math.max(1, Math.floor(cx / cols));
  const rowHeight = Math.max(228600, Math.floor(cy / Math.max(rows.length, 1)));
  const grid = Array.from({ length: cols }, () => `<a:gridCol w="${colWidth}"/>`).join('');
  const trs = rows.map((row, rowIndex) => `<a:tr h="${rowHeight}">${Array.from({ length: cols }, (_, i) => tableCell(row[i] ?? '', rowIndex === 0)).join('')}</a:tr>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${xmlEsc(table.name || 'Table')}"/><p:cNvGraphicFramePr/><p:nvPr><p:ph type="tbl"/></p:nvPr></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function tableCell(value, header = false) {
  const fill = header ? '1F4E79' : 'F8FAFC';
  const color = header ? 'FFFFFF' : '111827';
  const bold = header ? ' b="1"' : '';
  return `<a:tc><a:txBody><a:bodyPr lIns="91440" tIns="45720" rIns="91440" bIns="45720"/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-TW" sz="1200"${bold}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Aptos"/><a:ea typeface="Microsoft JhengHei"/></a:rPr><a:t>${xmlEsc(value)}</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:lnL w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:lnL><a:lnR w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:lnR><a:lnT w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:lnT><a:lnB w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:lnB></a:tcPr></a:tc>`;
}

function defaultTableBox(i) {
  return { x: 457200, y: 1600200 + i * 914400, cx: 8229600, cy: 2743200 };
}

function chartShape(id, chartInfo, box) {
  const fallback = defaultChartBox(0);
  const x = box.x ?? fallback.x, y = box.y ?? fallback.y, cx = box.cx ?? fallback.cx, cy = box.cy ?? fallback.cy;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${xmlEsc(chartInfo.name || 'Chart')}"/><p:cNvGraphicFramePr/><p:nvPr><p:ph type="chart"/></p:nvPr></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="${xmlEsc(chartInfo.relId)}"/></a:graphicData></a:graphic></p:graphicFrame>`;
}

function defaultChartBox(i) {
  return { x: 457200, y: 1600200 + i * 914400, cx: 8229600, cy: 2743200 };
}

function slideRelsXml(layoutPath, images = [], charts = []) {
  const target = '../' + layoutPath.replace(/^ppt\//, '');
  const imageRels = images.map((img) => `<Relationship Id="${xmlEsc(img.relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${xmlEsc(img.target)}"/>`).join('');
  const chartRels = charts.map((chart) => `<Relationship Id="${xmlEsc(chart.relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="${xmlEsc(chart.target)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${xmlEsc(target)}"/>${imageRels}${chartRels}</Relationships>`;
}

function updatePresentation(xml, slides) {
  let out = ensurePresentationNamespaces(xml);
  const startId = Math.max(255, ...[...out.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"/g)].map((m) => +m[1] || 0)) + 1;
  const entries = slides.map((s, i) => `<p:sldId id="${startId + i}" r:id="${s.relId}"/>`).join('');
  if (/<p:sldIdLst\b[\s\S]*?<\/p:sldIdLst>/.test(out)) return out.replace(/<\/p:sldIdLst>/, `${entries}</p:sldIdLst>`);
  return out.replace(/<\/p:presentation>/, `<p:sldIdLst>${entries}</p:sldIdLst></p:presentation>`);
}

function ensurePresentationNamespaces(xml) {
  return xml.replace(/<p:presentation\b([^>]*)>/, (_m, attrs) => {
    let next = attrs;
    if (!/\bxmlns:p=/.test(next)) next += ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    if (!/\bxmlns:r=/.test(next)) next += ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    return `<p:presentation${next}>`;
  });
}

function updatePresentationRels(xml, slides) {
  const rels = slides.map((s) => `<Relationship Id="${s.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${s.no}.xml"/>`).join('');
  return xml.replace(/<\/Relationships>/, `${rels}</Relationships>`);
}

function updateContentTypes(xml, slides, imageExts = new Set()) {
  let out = xml;
  if (!/Extension="rels"/.test(out)) out = out.replace(/<Types\b([^>]*)>/, '<Types$1><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>');
  if (!/Extension="xml"/.test(out)) out = out.replace(/<Types\b([^>]*)>/, '<Types$1><Default Extension="xml" ContentType="application/xml"/>');
  for (const ext of imageExts) {
    if (!new RegExp(`Extension="${ext}"`).test(out)) out = out.replace(/<Types\b([^>]*)>/, `<Types$1><Default Extension="${ext}" ContentType="${imageMimeFromExt(ext)}"/>`);
  }
  const overrides = slides.map((s) => `<Override PartName="/ppt/slides/slide${s.no}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  const chartOverrides = slides.flatMap((s) => s.charts || []).map((c) => `<Override PartName="/${c.path}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('');
  return out.replace(/<\/Types>/, `${overrides}${chartOverrides}</Types>`);
}

function defaultPresentationXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/></p:presentation>';
}
function defaultPresentationRels() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
}
function defaultContentTypes() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>';
}
function rootRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
}
function nextRid(xml) {
  return Math.max(0, ...[...xml.matchAll(/\bId="rId(\d+)"/g)].map((m) => +m[1] || 0)) + 1;
}
function slideNo(n) { return +(n.match(/slide(\d+)\.xml$/) || [])[1] || 0; }

function parseSlideSize(xml) {
  const m = xml.match(/<p:sldSz\b([^>]*)\/?>/);
  if (!m) return null;
  return { cx: numAttr(m[1], 'cx'), cy: numAttr(m[1], 'cy'), type: attr(m[1], 'type') || '' };
}

function parsePlaceholders(xml) {
  return [...xml.matchAll(/<p:(?:sp|pic|graphicFrame)\b[\s\S]*?<\/p:(?:sp|pic|graphicFrame)>/g)].map(([shape]) => {
    const phAttrs = (shape.match(/<p:ph\b([^>]*)\/?>/) || [])[1];
    if (phAttrs == null) return null;
    const xfrm = (shape.match(/<(?:a|p):xfrm\b[\s\S]*?<\/(?:a|p):xfrm>/) || [])[0] || '';
    const off = (xfrm.match(/<a:off\b([^>]*)\/?>/) || [])[1] || '';
    const ext = (xfrm.match(/<a:ext\b([^>]*)\/?>/) || [])[1] || '';
    return {
      type: attr(phAttrs, 'type') || 'body',
      idx: attr(phAttrs, 'idx') || '',
      orient: attr(phAttrs, 'orient') || '',
      sz: attr(phAttrs, 'sz') || '',
      x: numAttr(off, 'x'),
      y: numAttr(off, 'y'),
      cx: numAttr(ext, 'cx'),
      cy: numAttr(ext, 'cy'),
    };
  }).filter(Boolean);
}

function parseLayoutName(xml, path) {
  return decodeEntities((xml.match(/<p:sldLayout\b[^>]*\bname="([^"]*)"/) || [])[1] || basename(path, '.xml'));
}

function shapeBoxes(xml) {
  return [...xml.matchAll(/<p:(?:sp|pic|graphicFrame)\b[\s\S]*?<\/p:(?:sp|pic|graphicFrame)>/g)].map(([shape]) => {
    const name = decodeEntities((shape.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/) || [])[1] || '');
    const xfrm = (shape.match(/<(?:a|p):xfrm\b[\s\S]*?<\/(?:a|p):xfrm>/) || [])[0] || '';
    const off = (xfrm.match(/<a:off\b([^>]*)\/?>/) || [])[1] || '';
    const ext = (xfrm.match(/<a:ext\b([^>]*)\/?>/) || [])[1] || '';
    return { name, x: numAttr(off, 'x'), y: numAttr(off, 'y'), cx: numAttr(ext, 'cx'), cy: numAttr(ext, 'cy') };
  });
}

function analyzeSlideDesign(zip, slidePath, xml, rels) {
  const text = slideTextMetrics(xml);
  const tables = tableMetrics(xml);
  const charts = chartMetrics(zip, rels);
  const images = (xml.match(/<p:pic\b/g) || []).length;
  const visualObjects = images + tables.length + charts.length;
  const overlaps = overlappingContentShapes(xml);
  const issues = [];
  let score = 100;
  const warn = (code, message, penalty, extra = {}) => {
    score -= penalty;
    issues.push({ level: 'warning', code, slide: slidePath, message, ...extra });
  };

  if (text.titleLength > 28) warn('title-too-long', '標題偏長，容易壓縮或換行過多', 8, { titleLength: text.titleLength });
  if (text.bodyLines > BUSINESS_BODY_LINES_PER_SLIDE) warn('body-too-dense', `正文超過 ${BUSINESS_BODY_LINES_PER_SLIDE} 條，建議拆頁或改成分組`, 10, { bodyLines: text.bodyLines });
  if (text.maxLineLength > 55) warn('line-too-long', '有正文單行過長，投影片閱讀性會下降', 5, { maxLineLength: text.maxLineLength });
  const maxTableRows = Math.max(0, ...tables.map((t) => t.rows));
  if (maxTableRows > TABLE_ROWS_PER_SLIDE) warn('table-too-tall', `表格超過 ${TABLE_ROWS_PER_SLIDE} 列，建議拆頁或摘要`, 10, { rows: maxTableRows });
  const maxChartCategories = Math.max(0, ...charts.map((c) => c.categories));
  if (maxChartCategories > CHART_CATEGORIES_PER_SLIDE) warn('chart-too-many-categories', `圖表分類超過 ${CHART_CATEGORIES_PER_SLIDE} 個，座標標籤可能擁擠`, 10, { categories: maxChartCategories });
  const maxChartSeries = Math.max(0, ...charts.map((c) => c.series));
  if (maxChartSeries > 4) warn('chart-too-many-series', '圖表系列超過 4 組，圖例與線條可能難以辨識', 8, { series: maxChartSeries });
  if (visualObjects > 3) warn('too-many-visual-objects', '同頁圖片、表格與圖表物件過多，版面焦點可能不清楚', 8, { visualObjects });
  for (const overlap of overlaps) warn('shape-overlap', '內容物件發生重疊，版面不可交付', 18, overlap);

  return {
    slide: slidePath,
    score: Math.max(0, score),
    metrics: {
      titleLength: text.titleLength,
      bodyLines: text.bodyLines,
      maxLineLength: text.maxLineLength,
      images,
      tables: tables.length,
      maxTableRows,
      charts: charts.length,
      maxChartCategories,
      maxChartSeries,
      visualObjects,
    },
    issues,
  };
}

function summarizeDesign(slides) {
  const issues = slides.flatMap((s) => s.issues);
  const score = slides.length ? Math.round(slides.reduce((n, s) => n + s.score, 0) / slides.length) : 100;
  return {
    ok: score >= 80 && !issues.some((i) => ['body-too-dense', 'table-too-tall', 'chart-too-many-categories', 'shape-overlap'].includes(i.code)),
    score,
    slides,
    issues,
  };
}

function overlappingContentShapes(xml) {
  const boxes = shapeBoxes(xml).filter((box) =>
    !['', 'Accent Bar', 'Title Rule', 'Title 1'].includes(box.name)
    && Number.isFinite(box.x) && Number.isFinite(box.y)
    && Number.isFinite(box.cx) && Number.isFinite(box.cy)
    && box.cx > 0 && box.cy > 0);
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i], boxes[j])) overlaps.push({ shapes: [boxes[i].name, boxes[j].name] });
    }
  }
  return overlaps;
}

function slideTextMetrics(xml) {
  const blocks = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map(([shape]) => {
    const role = attr((shape.match(/<p:ph\b([^>]*)\/?>/) || [])[1] || '', 'type') || 'text';
    const paragraphs = [...shape.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
      .map(([p]) => tidyText(stripXml(p)))
      .filter(Boolean);
    return { role, paragraphs };
  });
  const title = blocks.find((b) => ['title', 'ctrTitle'].includes(b.role))?.paragraphs.join(' ') || '';
  const body = blocks.filter((b) => !['title', 'ctrTitle'].includes(b.role)).flatMap((b) => b.paragraphs);
  return {
    titleLength: textLength(title),
    bodyLines: body.length,
    maxLineLength: Math.max(0, ...body.map(textLength)),
  };
}

function tableMetrics(xml) {
  return [...xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/g)].map(([tbl]) => ({
    rows: (tbl.match(/<a:tr\b/g) || []).length,
    cols: Math.max(0, ...[...tbl.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map(([tr]) => (tr.match(/<a:tc\b/g) || []).length)),
  }));
}

function chartMetrics(zip, rels) {
  return [...rels.values()].filter((r) => /\/chart$/.test(r.type)).map((rel) => {
    const xml = zip.read(rel.path) || '';
    const series = [...xml.matchAll(/<c:ser\b[\s\S]*?<\/c:ser>/g)];
    return {
      path: rel.path,
      series: series.length,
      categories: Math.max(0, ...series.map(([ser]) => (ser.match(/<c:cat\b[\s\S]*?<\/c:cat>/) || [''])[0].match(/<c:pt\b/g)?.length || 0)),
    };
  });
}

function stripXml(xml) {
  return decodeEntities(String(xml || '').replace(/<a:br\b[^>]*\/?>/g, '\n').replace(/<[^>]+>/g, ''));
}
function tidyText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function textLength(s) {
  return [...String(s || '')].length;
}

function normalizeImages(images) {
  const list = Array.isArray(images) ? images : [images];
  return list.map((img) => typeof img === 'string' ? { path: img } : img).filter((img) => img && img.path);
}

function normalizeTables(tables) {
  const list = Array.isArray(tables) && Array.isArray(tables[0]) && !Array.isArray(tables[0][0])
    ? [tables]
    : (Array.isArray(tables) ? tables : [tables]);
  return list.map((table, i) => {
    const rows = Array.isArray(table) ? table : table?.rows;
    if (!Array.isArray(rows) || !rows.length) return null;
    return {
      name: typeof table?.name === 'string' ? table.name : `Table ${i + 1}`,
      rows: rows.map((row) => (Array.isArray(row) ? row : [row]).map((cell) => String(cell ?? ''))),
    };
  }).filter(Boolean);
}

function normalizeCharts(charts) {
  const list = Array.isArray(charts) ? charts : [charts];
  return list.map((chart, i) => {
    if (!chart) return null;
    const rows = Array.isArray(chart.rows) ? chart.rows : null;
    const categories = Array.isArray(chart.categories)
      ? chart.categories.map(String)
      : rows?.slice(1).map((r) => String(r?.[0] ?? ''));
    if (!categories?.length) return null;
    const series = normalizeChartSeries(chart, rows, categories.length);
    if (!series.length) return null;
    return {
      name: String(chart.name || chart.title || `Chart ${i + 1}`),
      type: normalizeChartType(chart.type),
      categories,
      series,
    };
  }).filter(Boolean);
}

function normalizeChartSeries(chart, rows, categoryCount) {
  if (Array.isArray(chart.series) && chart.series.length) {
    return chart.series.map((s, i) => {
      const values = Array.isArray(s.values) ? s.values : [];
      return chartSeries(s.name || `Series ${i + 1}`, values, categoryCount);
    }).filter(Boolean);
  }
  if (Array.isArray(chart.values)) return [chartSeries(chart.name || 'Series 1', chart.values, categoryCount)].filter(Boolean);
  if (rows?.length) {
    const headers = Array.isArray(rows[0]) ? rows[0].slice(1).map(String) : [];
    const width = Math.max(1, ...rows.slice(1).map((r) => Array.isArray(r) ? r.length - 1 : 0));
    return Array.from({ length: width }, (_, i) => chartSeries(headers[i] || `Series ${i + 1}`, rows.slice(1).map((r) => r?.[i + 1]), categoryCount)).filter(Boolean);
  }
  return [];
}

function chartSeries(name, values, categoryCount) {
  if (!Array.isArray(values) || !values.length) return null;
  const nums = values.slice(0, categoryCount).map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });
  return nums.length ? { name: String(name), values: nums } : null;
}

function normalizeChartType(type) {
  const t = String(type || 'bar').toLowerCase();
  return ['bar', 'line', 'pie'].includes(t) ? t : 'bar';
}

function chartXml(chart) {
  const chartBody = chart.type === 'line' ? lineChartXml(chart) : chart.type === 'pie' ? pieChartXml(chart) : barChartXml(chart);
  const axes = chart.type === 'pie' ? '' : chartAxesXml();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:date1904 val="0"/><c:lang val="zh-TW"/><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xmlEsc(chart.name)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/></c:title><c:plotArea><c:layout/>${chartBody}${axes}</c:plotArea><c:legend><c:legendPos val="r"/><c:layout/></c:legend><c:plotVisOnly val="1"/></c:chart><c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>`;
}

function barChartXml(chart) {
  return `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${chart.series.map((s, i) => chartSerXml(s, chart.categories, i)).join('')}<c:axId val="12345678"/><c:axId val="87654321"/></c:barChart>`;
}

function lineChartXml(chart) {
  return `<c:lineChart><c:grouping val="standard"/>${chart.series.map((s, i) => `${chartSerXml(s, chart.categories, i)}<c:smooth val="0"/>`).join('')}<c:axId val="12345678"/><c:axId val="87654321"/></c:lineChart>`;
}

function pieChartXml(chart) {
  return `<c:pieChart><c:varyColors val="1"/>${chartSerXml(chart.series[0], chart.categories, 0)}</c:pieChart>`;
}

function chartSerXml(series, categories, index) {
  const cats = categories.map((cat, i) => `<c:pt idx="${i}"><c:v>${xmlEsc(cat)}</c:v></c:pt>`).join('');
  const vals = series.values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('');
  return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${xmlEsc(series.name)}</c:v></c:tx><c:cat><c:strLit><c:ptCount val="${categories.length}"/>${cats}</c:strLit></c:cat><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${series.values.length}"/>${vals}</c:numLit></c:val></c:ser>`;
}

function chartAxesXml() {
  return '<c:catAx><c:axId val="12345678"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="87654321"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="87654321"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="12345678"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>';
}

function imageExt(path) {
  const ext = extname(String(path)).toLowerCase().replace(/^\./, '');
  if (ext === 'jpg') return 'jpeg';
  return ['png', 'jpeg', 'gif', 'webp'].includes(ext) ? ext : '';
}

function imageMimeFromExt(ext) {
  return { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || '';
}

function parseTheme(xml, path) {
  const fonts = [...xml.matchAll(/<a:(?:majorFont|minorFont)>[\s\S]*?<a:latin\b[^>]*\btypeface="([^"]*)"/g)]
    .map(([, f]) => decodeEntities(f)).filter(Boolean);
  const colors = [...xml.matchAll(/<(?:a:srgbClr|a:sysClr)\b([^>]*)\/?>/g)]
    .map(([, attrs]) => attr(attrs, 'val') || attr(attrs, 'lastClr'))
    .filter(Boolean)
    .map((c) => c.startsWith('#') ? c : `#${c}`);
  const name = decodeEntities((xml.match(/<a:theme\b[^>]*\bname="([^"]*)"/) || [])[1] || '');
  return { path, name, fonts: [...new Set(fonts)], colors: [...new Set(colors)] };
}

function mergeThemes(themes) {
  return {
    fonts: [...new Set(themes.flatMap((t) => t.fonts || []))],
    colors: [...new Set(themes.flatMap((t) => t.colors || []))],
  };
}

function relsMap(xml, sourcePath) {
  return new Map([...xml.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(([, attrs]) => {
    const id = attr(attrs, 'Id');
    const target = attr(attrs, 'Target');
    const type = attr(attrs, 'Type');
    if (!id || !target) return null;
    return [id, { id, type, target: decodeEntities(target), path: normalizeRel(sourcePath, decodeEntities(target)) }];
  }).filter(Boolean));
}

function relPath(path) {
  return path.replace(/^(.+\/)([^/]+)$/, '$1_rels/$2.rels');
}

function normalizeRel(sourcePath, target) {
  if (target.startsWith('/')) return target.replace(/^\//, '');
  const parts = sourcePath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function attr(attrs, name) {
  return (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] || '';
}
function numAttr(attrs, name) {
  const v = attr(attrs, name);
  return v === '' ? null : Number(v);
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');
}
function xmlEsc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function readZip(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('不是有效的 ZIP/PPTX 檔（找不到中央目錄）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const readBuffer = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const lo = e.localOff;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('ZIP local header 損壞');
    const nameLen = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const start = lo + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.compSize);
    const out = e.method === 0 ? data : e.method === 8 ? inflateRawSync(data) : null;
    if (out == null) throw new Error(`不支援的 ZIP 壓縮方式 ${e.method}`);
    return Buffer.from(out);
  };
  const read = (name) => readBuffer(name)?.toString('utf8') ?? null;
  const files = () => new Map([...entries.keys()].map((name) => [name, readBuffer(name)]).filter(([, data]) => data != null));
  return { read, readBuffer, files };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(local, 30);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42); nameBuf.copy(central, 46);
    const localFull = Buffer.concat([local, data]);
    locals.push(localFull); centrals.push(central); offset += localFull.length;
  }
  const localAll = Buffer.concat(locals), cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(localAll.length, 16);
  return Buffer.concat([localAll, cd, eocd]);
}

const BODY_LINES_PER_SLIDE = 7;
const BUSINESS_BODY_LINES_PER_SLIDE = 5;
const VISUAL_BODY_LINES_PER_SLIDE = 4;
const TABLE_ROWS_PER_SLIDE = 8;
const CHART_CATEGORIES_PER_SLIDE = 8;

function expandSlidesForCapacity(slides) {
  const out = [];
  for (const slide of slides) {
    const body = Array.isArray(slide.body) ? slide.body.map(String) : String(slide.body || '').split(/\r?\n/).filter(Boolean);
    const images = normalizeImages(slide.images || []);
    const tables = normalizeTables(slide.tables || slide.table || []);
    const charts = normalizeCharts(slide.charts || slide.chart || []);
    const bodyLimit = bodyLinesLimit(body);
    if (!images.length && !tables.length && charts.length === 1 && charts[0].categories.length > CHART_CATEGORIES_PER_SLIDE) {
      splitChartSlide(slide, charts[0]).forEach((s) => out.push(s));
      continue;
    }
    if (!images.length && !charts.length && tables.length === 1 && tables[0].rows.length > TABLE_ROWS_PER_SLIDE) {
      splitTableSlide(slide, tables[0]).forEach((s) => out.push(s));
      continue;
    }
    const hasAnchoredObjects = images.length || tables.length || charts.length;
    if (hasAnchoredObjects || body.length <= bodyLimit) {
      out.push(slide);
      continue;
    }
    const chunks = [];
    for (let i = 0; i < body.length; i += bodyLimit) chunks.push(body.slice(i, i + bodyLimit));
    chunks.forEach((chunk, i) => out.push({
      ...slide,
      title: i === 0 ? slide.title : `${slide.title || '投影片'}（續 ${i + 1}）`,
      body: chunk,
    }));
  }
  return out;
}

function splitTableSlide(slide, table) {
  const [header, ...dataRows] = table.rows;
  const keepHeader = dataRows.length > 0;
  const chunkSize = keepHeader ? TABLE_ROWS_PER_SLIDE - 1 : TABLE_ROWS_PER_SLIDE;
  const chunks = [];
  const rows = keepHeader ? dataRows : table.rows;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const part = rows.slice(i, i + chunkSize);
    chunks.push(keepHeader ? [header, ...part] : part);
  }
  return chunks.map((rows, i) => ({
    ...slide,
    title: i === 0 ? slide.title : `${slide.title || '投影片'}（續 ${i + 1}）`,
    tables: [{ ...table, rows }],
  }));
}

function splitChartSlide(slide, chart) {
  const chunks = [];
  for (let i = 0; i < chart.categories.length; i += CHART_CATEGORIES_PER_SLIDE) {
    const categories = chart.categories.slice(i, i + CHART_CATEGORIES_PER_SLIDE);
    const series = chart.series.map((s) => ({
      ...s,
      values: s.values.slice(i, i + CHART_CATEGORIES_PER_SLIDE),
    })).filter((s) => s.values.length);
    if (categories.length && series.length) chunks.push({ categories, series });
  }
  return chunks.map((part, i) => ({
    ...slide,
    title: i === 0 ? slide.title : `${slide.title || '投影片'}（續 ${i + 1}）`,
    charts: [{ ...chart, categories: part.categories, series: part.series }],
  }));
}

function imageDimensions(buf, ext) {
  if (ext === 'png' && buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (ext === 'jpeg') return jpegDimensions(buf);
  return null;
}

function jpegDimensions(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    const len = buf.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
    offset += 2 + len;
  }
  return null;
}

function fitBox(box, dimensions, fit = 'contain') {
  const fallback = defaultImageBox(0);
  const base = { x: box.x ?? fallback.x, y: box.y ?? fallback.y, cx: box.cx ?? fallback.cx, cy: box.cy ?? fallback.cy };
  if (!dimensions?.width || !dimensions?.height) return base;
  const imgRatio = dimensions.width / dimensions.height;
  const boxRatio = base.cx / base.cy;
  if (fit === 'cover') return base;
  let cx = base.cx, cy = base.cy;
  if (imgRatio > boxRatio) cy = Math.round(cx / imgRatio);
  else cx = Math.round(cy * imgRatio);
  return { x: Math.round(base.x + (base.cx - cx) / 2), y: Math.round(base.y + (base.cy - cy) / 2), cx, cy };
}
