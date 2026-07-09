(function () {
  const escOffice = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let previewSeq = 0;

  function renderQualitySummary(doc) {
    const quality = doc?.quality || null;
    const verify = doc?.verify || null;
    const design = verify?.design || quality?.design || null;
    const repairs = Array.isArray(doc?.repairs) ? doc.repairs : Array.isArray(quality?.repairs) ? quality.repairs : [];
    if (!quality && !verify && !repairs.length) return "";

    const failed = quality?.ok === false || verify?.ok === false || design?.ok === false;
    const warned = (quality?.issueCount || 0) > 0 || repairs.length > 0 || (Array.isArray(design?.issues) && design.issues.length > 0);
    const state = failed ? "fail" : warned ? "warn" : "pass";
    const label = state === "pass" ? "可交付" : state === "warn" ? "需注意" : "未通過";
    const metrics = [];
    if (quality?.grade) metrics.push(`grade ${escOffice(quality.grade)}`);
    if (typeof quality?.score === "number") metrics.push(`score ${quality.score}`);
    else if (typeof design?.score === "number") metrics.push(`design ${design.score}`);
    if (typeof quality?.repairCount === "number") metrics.push(`修正 ${quality.repairCount}`);
    else if (repairs.length) metrics.push(`修正 ${repairs.length}`);
    if (typeof quality?.issueCount === "number") metrics.push(`問題 ${quality.issueCount}`);
    if (typeof quality?.timingsMs?.total === "number") metrics.push(`${quality.timingsMs.total}ms`);

    const repairText = repairs.slice(0, 3).map((r) => r?.message || r?.code || r).filter(Boolean).map(escOffice).join("；");
    const designIssues = Array.isArray(design?.issues) ? design.issues.slice(0, 3).map(escOffice).join("；") : "";
    const repairMore = repairs.length > 3 ? "…" : "";
    const issueMore = Array.isArray(design?.issues) && design.issues.length > 3 ? "…" : "";
    const repairHtml = repairText ? `<div class="office-quality-detail">已自動修正：${repairText}${repairMore}</div>` : "";
    const issueHtml = designIssues ? `<div class="office-quality-detail">設計檢查：${designIssues}${issueMore}</div>` : "";
    return `<div class="office-quality office-quality-${state}"><div class="office-quality-head"><span class="office-quality-badge">${label}</span><span class="office-quality-metrics">${metrics.join(" · ")}</span></div>${repairHtml}${issueHtml}</div>`;
  }

  function officeTable(rows) {
    const shown = (rows || []).slice(0, 200).map((r) => Array.isArray(r) ? r : (r.cells || []));
    const width = Math.min(40, Math.max(1, ...shown.map((r) => r.length)));
    const head = `<tr>${Array.from({ length: width }, (_, i) => `<th>${i + 1}</th>`).join("")}</tr>`;
    const body = shown.map((r) => `<tr>${Array.from({ length: width }, (_, i) => `<td>${escOffice(r[i] || "")}</td>`).join("")}</tr>`).join("");
    const note = (rows || []).length > shown.length ? `<div class="office-note">只顯示前 ${shown.length} 列，完整內容請下載原檔。</div>` : "";
    return `<div class="office-table-wrap"><table class="office-table">${head}${body}</table></div>${note}`;
  }

  function officeSheetMeta(sheet) {
    const parts = [];
    if ((sheet.merges || []).length) parts.push(`合併儲存格：${escOffice(sheet.merges.slice(0, 8).join(", "))}${sheet.merges.length > 8 ? "…" : ""}`);
    if ((sheet.formulas || []).length) {
      const fs = sheet.formulas.slice(0, 6).map((f) => `${f.ref || "?"}=${f.formula}`).join("; ");
      parts.push(`公式：${escOffice(fs)}${sheet.formulas.length > 6 ? "…" : ""}`);
    }
    return parts.length ? `<div class="office-note">${parts.join("<br>")}</div>` : "";
  }

  function renderSheet(sheet) {
    return `<section class="office-sheet"><h3 class="office-title">${escOffice(sheet.name || ("工作表 " + sheet.index))}</h3>${officeSheetMeta(sheet)}${officeTable(sheet.rows || [])}</section>`;
  }

  function renderWorkbook(sheets) {
    if (!sheets.length) return "";
    if (sheets.length === 1) return renderSheet(sheets[0]);
    const rootId = `office-wb-${++previewSeq}`;
    const tabs = sheets.map((s, i) =>
      `<button class="office-tab${i === 0 ? " active" : ""}" type="button" role="tab" aria-selected="${i === 0 ? "true" : "false"}" onclick="officePreviewShowSheet('${rootId}', ${i})">${escOffice(s.name || ("工作表 " + s.index))}</button>`
    ).join("");
    const panels = sheets.map((s, i) =>
      `<div class="office-sheet-panel${i === 0 ? " active" : ""}" role="tabpanel" data-office-sheet="${i}"${i === 0 ? "" : " hidden"}>${renderSheet(s)}</div>`
    ).join("");
    return `<div class="office-workbook" id="${rootId}"><div class="office-tabs" role="tablist" aria-label="工作表">${tabs}</div>${panels}</div>`;
  }

  function slideParts(slide) {
    if (slide.title || (slide.body || []).length) {
      return {
        title: String(slide.title || `投影片 ${slide.index}`).trim(),
        bullets: (slide.body || []).map((s) => String(s).trim()).filter(Boolean),
      };
    }
    const lines = String(slide.text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { title: lines[0] || `投影片 ${slide.index}`, bullets: lines.slice(1) };
  }

  function slideLayoutClass(slide, bullets) {
    const media = (slide.images || []).length;
    const data = (slide.tables || []).length + (slide.charts || []).length;
    if (media && data) return " office-slide-layout-rich";
    if (media && bullets.length <= 3) return " office-slide-layout-media";
    if (data && bullets.length <= 4) return " office-slide-layout-data";
    return "";
  }

  function slideMeta(slide) {
    const parts = [];
    if ((slide.images || []).length) parts.push(`${slide.images.length} 圖`);
    if ((slide.tables || []).length) parts.push(`${slide.tables.length} 表`);
    if ((slide.charts || []).length) parts.push(`${slide.charts.length} 圖表`);
    return parts.length ? `<span>${parts.map(escOffice).join(" · ")}</span>` : "";
  }

  function renderSlide(slide) {
    const { title, bullets } = slideParts(slide);
    const bulletHtml = bullets.length
      ? `<ul class="office-slide-bullets">${bullets.map((b) => `<li>${escOffice(b)}</li>`).join("")}</ul>`
      : `<p class="office-text">${escOffice(slide.text || "此投影片沒有可萃取的文字內容。")}</p>`;
    const mediaHtml = (slide.images || []).length
      ? `<div class="office-slide-media">${slide.images.map((img) => img.dataUrl
        ? `<figure class="office-slide-figure"><img src="${escOffice(img.dataUrl)}" alt="${escOffice(img.name || "slide image")}" loading="lazy">${img.name ? `<figcaption>${escOffice(img.name)}</figcaption>` : ""}</figure>`
        : `<div class="office-slide-media-omitted">${escOffice(img.name || "圖片")} 已略過</div>`).join("")}</div>`
      : "";
    const tableHtml = (slide.tables || []).length
      ? `<div class="office-slide-tables">${slide.tables.map((t, i) => `<div class="office-slide-data"><div class="office-data-title">表格 ${t.index || i + 1}</div>${officeTable(t.rows || [])}</div>`).join("")}</div>`
      : "";
    const chartHtml = (slide.charts || []).length
      ? `<div class="office-slide-charts">${slide.charts.map(renderChartSummary).join("")}</div>`
      : "";
    const dataHtml = tableHtml || chartHtml ? `<div class="office-slide-data-zone">${tableHtml}${chartHtml}</div>` : "";
    return `<section class="office-slide-card${slideLayoutClass(slide, bullets)}"><div class="office-slide-page"><span>投影片 ${slide.index}</span>${slideMeta(slide)}</div><h3 class="office-slide-title">${escOffice(title)}</h3><div class="office-slide-content"><div class="office-slide-copy">${bulletHtml}</div>${mediaHtml}${dataHtml}</div></section>`;
  }

  function renderChartSummary(chart) {
    const series = (chart.series || []).slice(0, 4).map((s) => {
      const pairs = (s.categories || []).slice(0, 6).map((c, i) => `${escOffice(c)}: ${escOffice((s.values || [])[i] ?? "")}`).join(" · ");
      return `<li><strong>${escOffice(s.name || "Series")}</strong>${pairs ? `<span>${pairs}</span>` : ""}</li>`;
    }).join("");
    const more = (chart.series || []).length > 4 ? `<div class="office-note">另有 ${(chart.series || []).length - 4} 個系列，完整內容請下載原檔。</div>` : "";
    return `<div class="office-chart-summary"><div class="office-data-title">${escOffice(chart.title || "圖表")} <span>${escOffice(chart.type || "chart")}</span></div><ul>${series}</ul>${more}</div>`;
  }

  function renderDeck(slides) {
    if (!slides.length) return "";
    const rootId = `office-deck-${++previewSeq}`;
    const thumbs = slides.map((s, i) => {
      const { title } = slideParts(s);
      return `<button class="office-slide-thumb${i === 0 ? " active" : ""}" type="button" aria-current="${i === 0 ? "true" : "false"}" onclick="officePreviewShowSlide('${rootId}', ${i})"><span>${s.index}</span><strong>${escOffice(title)}</strong></button>`;
    }).join("");
    const panels = slides.map((s, i) =>
      `<div class="office-slide-panel${i === 0 ? " active" : ""}" data-office-slide="${i}"${i === 0 ? "" : " hidden"}>${renderSlide(s)}</div>`
    ).join("");
    return `<div class="office-deck" id="${rootId}"><div class="office-deck-rail"><div class="office-deck-count">${slides.length} 張投影片</div><div class="office-slide-thumbs" aria-label="投影片">${thumbs}</div></div><div class="office-slide-stage">${panels}</div></div>`;
  }

  function renderOfficePreview(doc, preClass = "preview-pre") {
    const qualityHtml = renderQualitySummary(doc);
    if (!doc || !doc.ok) return `${qualityHtml}<pre class="${preClass}">${escOffice(doc?.text || "")}</pre>`;
    const warningHtml = (doc.warnings || []).length
      ? `<div class="office-warning">${doc.warnings.map((w) => escOffice(w)).join("<br>")}</div>`
      : "";
    if (doc.kind === "docx" && Array.isArray(doc.blocks)) {
      const html = doc.blocks.map((b) => b.type === "table"
        ? `<div class="office-block">${officeTable(b.rows || [])}</div>`
        : `<div class="office-block"><p class="office-text">${escOffice(b.text || "")}</p></div>`).join("");
      return `<div class="office-preview">${qualityHtml}${warningHtml}${html || `<pre class="${preClass}">${escOffice(doc.text || "")}</pre>`}</div>`;
    }
    if (doc.kind === "xlsx" && Array.isArray(doc.sheets)) {
      const html = renderWorkbook(doc.sheets);
      return `<div class="office-preview">${qualityHtml}${warningHtml}${html || `<pre class="${preClass}">${escOffice(doc.text || "")}</pre>`}</div>`;
    }
    if (doc.kind === "pptx" && Array.isArray(doc.slides)) {
      const html = renderDeck(doc.slides);
      return `<div class="office-preview">${qualityHtml}${warningHtml}${html || `<pre class="${preClass}">${escOffice(doc.text || "")}</pre>`}</div>`;
    }
    return `<div class="office-preview">${qualityHtml}${warningHtml}<pre class="${preClass}">${escOffice(doc.text || "")}</pre></div>`;
  }

  window.officePreviewShowSheet = function officePreviewShowSheet(rootId, idx) {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.querySelectorAll(".office-tab").forEach((btn, i) => {
      const active = i === idx;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    root.querySelectorAll(".office-sheet-panel").forEach((panel, i) => {
      const active = i === idx;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
  };
  window.officePreviewShowSlide = function officePreviewShowSlide(rootId, idx) {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.querySelectorAll(".office-slide-thumb").forEach((btn, i) => {
      const active = i === idx;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-current", active ? "true" : "false");
    });
    root.querySelectorAll(".office-slide-panel").forEach((panel, i) => {
      const active = i === idx;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
  };
  window.renderOfficePreview = renderOfficePreview;
})();
