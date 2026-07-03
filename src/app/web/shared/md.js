/* ── Markdown 渲染（Web 共用，零依賴、可離線）─────────────────
 * 對話頁（chat）、許願台（index）、會議室（room）共用同一個 mdRender，
 * 讓 AI 回覆的排版三處一致（標題、粗/斜/刪除線、行內碼、程式碼區塊、
 * 有序/無序/巢狀/待辦清單、blockquote、GFM 表格、連結、圖片、水平線）。
 * 樣式沿用 shared/style.css 的 .md 系列 token。
 * 以 IIFE 封裝、只對外掛一個全域 mdRender，避免與各頁 inline script 的
 * const（esc/$ 等）撞名。 */
(function () {
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // 強調標記（不含碼/連結，那些由 inline 先抽出保護）：**粗**、__粗__、*斜*、_斜_、~~刪除線~~。
  // 底線變體限「詞邊界」→ 不誤傷 snake_case（a_b_c、file_name）；星號變體維持原行為。
  const emph = (s) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<![\p{L}\p{N}])__(?!\s)([^_]+?)(?<!\s)__(?![\p{L}\p{N}])/gu, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
      .replace(/(?<![\p{L}\p{N}_])_(?!\s)([^_]+?)(?<!\s)_(?![\p{L}\p{N}_])/gu, "<em>$1</em>");

  // 行內語法：先轉義防 XSS。碼/圖/連結先抽成佔位符（用哨兵 \u0000N\u0000，正常文字不會出現），
  // 保護其內容不被強調規則誤傷（例如 code 或 URL 內的 snake_case 底線、星號）；連結「顯示文字」照樣套強調。
  const SENT = "\u0000";
  const inline = (raw) => {
    const holds = [];
    const hold = (html) => { holds.push(html); return SENT + (holds.length - 1) + SENT; };
    const t = esc(raw)
      .replace(/`([^`]+)`/g, (_, c) => hold("<code>" + c + "</code>"))
      .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, (_, a, u) => hold(`<img alt="${a}" src="${u}" loading="lazy">`))
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, x, u) => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${emph(x)}</a>`));
    return emph(t).replace(/\u0000(\d+)\u0000/g, (_, i) => holds[+i]);
  };

  const mdRender = (src) => {
    const lines = String(src).replace(/\r/g, "").split("\n");
    const out = [];
    let inCode = false, buf = [], codeLang = "";

    // 巢狀清單以縮排堆疊管理：stack = [{ tag:'ul'|'ol', indent }]
    const listStack = [];
    // 開清單標籤：有序清單保留起始號（`3.` 開頭 → <ol start="3">），非 1 才加屬性。
    const openList = (tag, startNum) => (tag === "ol" && startNum && startNum !== 1 ? `<ol start="${startNum}">` : "<" + tag + ">");
    const closeListsTo = (indent) => {
      while (listStack.length && listStack[listStack.length - 1].indent >= indent)
        out.push("</" + listStack.pop().tag + ">");
    };
    const closeAllLists = () => { while (listStack.length) out.push("</" + listStack.pop().tag + ">"); };

    // GFM 表格：一行含 |，下一行是分隔列（| --- | :--: | ...）
    const rowCells = (s) =>
      s.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const isSep = (s) =>
      s.includes("-") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
    const alignOf = (spec) => {
      const t = spec.trim(), l = t.startsWith(":"), r = t.endsWith(":");
      return l && r ? "center" : r ? "right" : l ? "left" : "";
    };
    const cellStyle = (a) => (a ? ` style="text-align:${a}"` : "");

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];

      // 程式碼塊（``` 圍欄，可帶語言）
      const fence = ln.match(/^```(\S*)/);
      if (fence) {
        if (inCode) {
          out.push(`<pre class='code'><code${codeLang ? ` class="lang-${esc(codeLang)}"` : ""}>` + esc(buf.join("\n")) + "</code></pre>");
          buf = []; inCode = false; codeLang = "";
        } else {
          closeAllLists(); inCode = true; codeLang = fence[1] || "";
        }
        continue;
      }
      if (inCode) { buf.push(ln); continue; }

      // 標題 h1-h6
      const h = ln.match(/^(#{1,6})\s+(.*)/);
      if (h) { closeAllLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

      // 水平線（---、***、___）
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(ln)) { closeAllLists(); out.push("<hr>"); continue; }

      // GFM 表格
      if (ln.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && isSep(lines[i + 1])) {
        closeAllLists();
        const header = rowCells(ln);
        const aligns = rowCells(lines[i + 1]).map(alignOf);
        let j = i + 2;
        const body = [];
        while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
          body.push(rowCells(lines[j])); j++;
        }
        out.push("<table class='md-table'><thead><tr>" +
          header.map((c, k) => `<th${cellStyle(aligns[k])}>${inline(c)}</th>`).join("") + "</tr></thead>");
        if (body.length) {
          out.push("<tbody>" + body.map((r) => "<tr>" +
            header.map((_, k) => `<td${cellStyle(aligns[k])}>${inline(r[k] || "")}</td>`).join("") +
            "</tr>").join("") + "</tbody>");
        }
        out.push("</table>");
        i = j - 1;
        continue;
      }

      // blockquote
      if (ln.startsWith("> ")) { closeAllLists(); out.push(`<blockquote>${inline(ln.slice(2))}</blockquote>`); continue; }

      // 清單（有序 <ol> / 無序 <ul> / 待辦 / 依縮排巢狀）
      const li = ln.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
      if (li) {
        const indent = li[1].replace(/\t/g, "  ").length;
        const tag = /\d/.test(li[2]) ? "ol" : "ul";
        const startNum = tag === "ol" ? parseInt(li[2], 10) : 0; // 有序清單起始號（供 <ol start>）
        // 收掉比目前更深的清單
        while (listStack.length && listStack[listStack.length - 1].indent > indent)
          out.push("</" + listStack.pop().tag + ">");
        const top = listStack[listStack.length - 1];
        if (!top || top.indent < indent) { out.push(openList(tag, startNum)); listStack.push({ tag, indent }); }
        else if (top.indent === indent && top.tag !== tag) {
          out.push("</" + top.tag + ">"); listStack.pop();
          out.push(openList(tag, startNum)); listStack.push({ tag, indent });
        }
        // 待辦清單 [ ] / [x]
        const task = li[3].match(/^\[([ xX])\]\s+(.*)/);
        if (task) {
          const done = task[1].toLowerCase() === "x";
          out.push(`<li class="task" style="list-style:none;margin-left:-1.2em">${done ? "☑" : "☐"} ${inline(task[2])}</li>`);
        } else {
          out.push("<li>" + inline(li[3]) + "</li>");
        }
        continue;
      }

      // 空行 → 收掉清單
      if (ln.trim() === "") { closeAllLists(); continue; }

      // 普通段落
      closeAllLists();
      out.push("<p>" + inline(ln) + "</p>");
    }

    closeAllLists();
    if (inCode)
      out.push(`<pre class='code'><code${codeLang ? ` class="lang-${esc(codeLang)}"` : ""}>` + esc(buf.join("\n")) + "</code></pre>");
    return out.join("");
  };

  // 掛全域：各頁 inline script 與 app.js 直接呼叫 mdRender(...)
  window.mdRender = mdRender;
})();
