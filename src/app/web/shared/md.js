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

  // 行內語法：先轉義防 XSS，再逐一還原成標記。順序：碼→圖→連結→粗→刪除線→斜。
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img alt="$1" src="$2" loading="lazy">')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  const mdRender = (src) => {
    const lines = String(src).replace(/\r/g, "").split("\n");
    const out = [];
    let inCode = false, buf = [], codeLang = "";

    // 巢狀清單以縮排堆疊管理：stack = [{ tag:'ul'|'ol', indent }]
    const listStack = [];
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
        // 收掉比目前更深的清單
        while (listStack.length && listStack[listStack.length - 1].indent > indent)
          out.push("</" + listStack.pop().tag + ">");
        const top = listStack[listStack.length - 1];
        if (!top || top.indent < indent) { out.push("<" + tag + ">"); listStack.push({ tag, indent }); }
        else if (top.indent === indent && top.tag !== tag) {
          out.push("</" + top.tag + ">"); listStack.pop();
          out.push("<" + tag + ">"); listStack.push({ tag, indent });
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
