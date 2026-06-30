/**
 * xitto web — 共享工具庫
 * 
 * 由 index.html / chat.html 引入，共用所有工具函式。
 * 設定（token/packs/local）由各頁 HTML 的 inline script 注入 window.__XITTO__——
 * 因為 server 只對 HTML 做 __SERVER_TOKEN__/__PACKS__/__LOCAL__ 替換，靜態 JS 不會被替換。
 */

/* ── 1. 全域常量（讀自 HTML 注入的 window.__XITTO__）──────── */
const __CFG = (typeof window !== "undefined" && window.__XITTO__) || {};
const TOKEN = __CFG.token || "";
const PACKS = __CFG.packs || [];
const LOCAL = !!__CFG.local;

/* ── 2. DOM 工具 ─────────────────────────────────────── */
const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];

/* ── 3. HTML 跳脫 ─────────────────────────────────────── */
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * JS 字串 → HTML 屬性（雙引號包裝）
 * 用於 onclick / onchange 內嵌屬性的值。
 * 先 JS 跳脫、再 HTML 屬性跳脫。
 * 處理 Windows 路徑（如 C:\Users）避免被反斜線吃掉的問題。
 */
const jsAttr = (s) =>
  String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/* ── 4. API 呼叫 ──────────────────────────────────────── */
const api = (p, opts = {}) =>
  fetch(p, {
    ...opts,
    headers: {
      authorization: "Bearer " + TOKEN,
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });

/** 讀 SSE 串流：逐 `data:` 事件解析後丟給 onEv（許願台與對話頁共用）。*/
async function readSSE(resp, onEv) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!chunk.startsWith("data: ")) continue;
      let ev;
      try { ev = JSON.parse(chunk.slice(6)); } catch { continue; }
      onEv(ev);
    }
  }
}

/* ── 5. 主題切換 ─────────────────────────────────────── */
const applyTheme = (t) => {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("xk_theme", t);
  const btn = $("#theme");
  if (btn) btn.textContent = t === "light" ? "☀️" : "🌙";
};

// 早期套用（避免 FOUC）：
// localStorage 優先 → 否則跟隨系統 → 否則深色
(function () {
  try {
    var t =
      localStorage.getItem("xk_theme") ||
      (window.matchMedia &&
      matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark");
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();

/* ── 6. 專案/空間 ─────────────────────────────────────── */
let spaces = JSON.parse(localStorage.getItem("xk_spaces") || '["default"]');
let curSpace = localStorage.getItem("xk_space") || "default";

const spaceLabel = (s) =>
  s.startsWith("/")
    ? "📁 " + (s.split("/").filter(Boolean).pop() || s)
    : s;

function renderSpaces(selectEl = $("#space")) {
  if (!selectEl) return;
  selectEl.innerHTML = spaces
    .map((s) => `<option value="${esc(s)}" ${s === curSpace ? "selected" : ""}>${esc(spaceLabel(s))}</option>`)
    .join("");
}

function switchSpace(space) {
  curSpace = space;
  localStorage.setItem("xk_space", curSpace);
}

function addSpace(space) {
  if (!spaces.includes(space)) spaces.push(space);
  localStorage.setItem("xk_spaces", JSON.stringify(spaces));
}

/* ── 6b. 專案切換器（popover）+ 資料夾選擇（兩頁共用）──────────
   頁面需提供 DOM：#proj-switch（內含 #proj-btn、#proj-menu）與 #fs-modal。
   各頁呼叫 mountProjectSwitcher(onChange)；onChange 做頁面專屬刷新（對話：開新對話；許願台：重載歷史/檔案）。 */
let _projOnChange = () => {};

function mountProjectSwitcher(onChange) {
  _projOnChange = onChange || (() => {});
  renderProjectSwitcher();
  const btn = $("#proj-btn");
  if (btn) btn.onclick = (e) => { e.stopPropagation(); toggleProjMenu(); };
  document.addEventListener("click", (e) => { if (!$("#proj-switch")?.contains(e.target)) closeProjMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeProjMenu(); });
}

function renderProjectSwitcher() {
  const btn = $("#proj-btn");
  if (!btn) return;
  const name = spaceLabel(curSpace).replace(/^📁 /, "");
  btn.innerHTML = `<span class="proj-ic">📁</span><span class="proj-name" title="${esc(curSpace)}">${esc(name)}</span><span class="proj-caret">▾</span>`;
}

function toggleProjMenu() { const m = $("#proj-menu"); if (!m) return; m.hidden ? openProjMenu() : closeProjMenu(); }
function closeProjMenu() { const m = $("#proj-menu"); if (m) m.hidden = true; const b = $("#proj-btn"); if (b) b.setAttribute("aria-expanded", "false"); }
function openProjMenu() {
  const m = $("#proj-menu"); if (!m) return;
  const items = spaces.map((s) =>
    `<button class="proj-item${s === curSpace ? " on" : ""}" type="button" role="option" aria-selected="${s === curSpace}" onclick="pickSpace('${jsAttr(s)}')">
      <span class="proj-tick">${s === curSpace ? "✓" : ""}</span><span class="proj-lbl">${esc(spaceLabel(s))}</span></button>`).join("");
  m.innerHTML = `<div class="proj-group">切換專案</div>${items}<div class="proj-sep"></div>`
    + (LOCAL ? `<button class="proj-item action" type="button" onclick="projBrowse()"><span class="proj-tick">📁</span><span class="proj-lbl">選資料夾…</span></button>` : "")
    + `<button class="proj-item action" type="button" onclick="projNew()"><span class="proj-tick">＋</span><span class="proj-lbl">新專案…</span></button>`;
  m.hidden = false;
  const b = $("#proj-btn"); if (b) b.setAttribute("aria-expanded", "true");
}

function pickSpace(s) { closeProjMenu(); if (s === curSpace) return; switchSpace(s); renderProjectSwitcher(); _projOnChange(); }
function projNew() {
  closeProjMenu();
  const raw = (prompt(LOCAL
    ? "新專案：輸入名稱，或貼上一個真實資料夾的絕對路徑（本地模式會就地改該資料夾）"
    : "新專案名稱（英數/底線/連字號）：") || "").trim();
  if (!raw) return;
  const n = LOCAL && raw.startsWith("/") ? raw : raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!n) return;
  addSpace(n); switchSpace(n); renderProjectSwitcher(); _projOnChange();
}
function projBrowse() { closeProjMenu(); openFs(); }

/* 資料夾選擇 Modal（本地模式，用 /v1/fs 瀏覽真實目錄）*/
let fsPath = null, fsShowHidden = localStorage.getItem("xk_fshidden") === "1";
function openFs() { const mo = $("#fs-modal"); if (!mo) return; mo.hidden = false; const h = $("#fs-hidden"); if (h) h.checked = fsShowHidden; fsGo(null); }
function fsGo(opts) {
  opts = opts || {};
  const qs = [];
  if (opts.path) qs.push("path=" + encodeURIComponent(opts.path));
  if (opts.name) qs.push("name=" + encodeURIComponent(opts.name));
  if (opts.up) qs.push("up=1");
  if (fsShowHidden) qs.push("hidden=1");
  api("/v1/fs" + (qs.length ? "?" + qs.join("&") : ""))
    .then((r) => r.json())
    .then((r) => {
      if (r.error) { alert(r.error); return; }
      fsPath = r.path; window._fsHome = r.home;
      const pathEl = $("#fs-path"); if (pathEl) pathEl.textContent = "📂 " + r.path;
      const drivesRow = r.drives && r.drives.length
        ? `<div class="fs-drives">${r.drives.map((dv) => `<button class="fs-drive" onclick="fsGo({path:'${jsAttr(dv)}'})" title="切換到 ${esc(dv)}">💽 ${esc(dv.replace(/\\$/, ""))}</button>`).join("")}</div>`
        : "";
      const rows = [
        `<button class="fs-row up" onclick="fsUp()" role="treeitem" tabindex="0" type="button">⬆ 上一層</button>`,
        ...(r.dirs.length
          ? r.dirs.map((d) => `<button class="fs-row${d.startsWith(".") ? " hid" : ""}" onclick="fsEnter('${jsAttr(d)}')" role="treeitem" tabindex="0" type="button">📁 ${esc(d)}</button>`)
          : [`<div class="empty" style="padding:12px">（沒有子資料夾，可直接選這個）</div>`]),
      ];
      $("#fs-list").innerHTML = drivesRow + rows.join("");
    })
    .catch(() => ({ error: "讀取失敗" }));
}
function fsEnter(name) { return fsGo({ path: fsPath, name }); }
function fsUp() { return fsGo({ path: fsPath, up: true }); }
function fsToggleHidden() { fsShowHidden = $("#fs-hidden").checked; localStorage.setItem("xk_fshidden", fsShowHidden ? "1" : "0"); fsGo(fsPath); }
function fsHome() { fsGo(window._fsHome || null); }
function closeFs() { const mo = $("#fs-modal"); if (mo) mo.hidden = true; }
function chooseFs() { if (!fsPath) return; const p = fsPath; addSpace(p); switchSpace(p); renderProjectSwitcher(); closeFs(); _projOnChange(); }

/* ── 7. 工具人話 ─────────────────────────────────────── */
const TOOL_ZH = {
  read: "讀取檔案",
  ls: "查看目錄",
  glob: "尋找檔案",
  grep: "搜尋內容",
  write: "建立檔案",
  edit: "修改檔案",
  bash: "執行指令",
  web_search: "搜尋網路",
  web_fetch: "讀取網頁",
  http: "呼叫 API",
  read_image: "看圖片",
  skill: "載入技能",
  skill_save: "記錄技能",
  skills_check: "複查技能",
  playbook_update: "記下做法",
  episode_record: "記下經驗",
  episode_recall: "回想經驗",
  memory_save: "記住重點",
  todo_write: "規劃步驟",
  spawn_agent: "派出子助手",
  spawn_agents: "派出子助手群",
  ask_user: "來問你",
};

const LABELS = {
  general: "通用",
  coding: "程式",
  "data-query": "查資料",
  notes: "筆記",
  "deep-research": "研究",
  devops: "維運",
  patent: "專利",
  uiux: "介面",
};

const packLabel = (p) => LABELS[p] || p;

/** 各領域一句話說明（給手動挑選時看，hover 也顯示）*/
const PACK_DESC = {
  general: "一般任務、查網頁、寫檔",
  coding: "讀寫程式碼、跑指令、git",
  "data-query": "用自然語言查資料庫",
  notes: "知識庫、筆記整理",
  "deep-research": "多來源查證後給結論",
  devops: "部署、設定、健康檢查",
  patent: "找發明點、起草揭露書",
  uiux: "無障礙、響應式 UI",
};

const packDesc = (p) => PACK_DESC[p] || "";

/** 工具動作翻人話 */
const toolText = (a) => {
  const z = TOOL_ZH[a.name] || a.name;
  const d =
    a.args &&
    (a.args.command ||
      a.args.path ||
      a.args.query ||
      a.args.url ||
      a.args.topic ||
      a.args.name) ||
    "";
  return z + (d ? ` ${String(d).slice(0, 60)}` : "");
};

/* ── 8. Markdown 渲染 ────────────────────────────────── */
/**
 * 極簡 markdown 渲染（零依賴，可離線）。
 * 支援：h1-h4, p, ul/ol, code, pre, strong, em, a, blockquote, GFM 表格。
 * 不足：task list、巢狀列表。
 */
const mdRender = (src) => {
  const lines = String(src).replace(/\r/g, "").split("\n");
  const out = [];
  let inCode = false,
    buf = [],
    inList = false,
    inBlockquote = false;

  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const closeL = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

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
    // 程式碼塊
    if (/^```/.test(ln)) {
      if (inCode) {
        out.push(
          "<pre class='code'><code>" + esc(buf.join("\n")) + "</code></pre>"
        );
        buf = [];
        inCode = false;
      } else {
        closeL();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      buf.push(ln);
      continue;
    }

    // 標題
    const h = ln.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      closeL();
      out.push(
        `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`
      );
      continue;
    }

    // GFM 表格
    if (ln.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && isSep(lines[i + 1])) {
      closeL();
      const header = rowCells(ln);
      const aligns = rowCells(lines[i + 1]).map(alignOf);
      let j = i + 2;
      const body = [];
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        body.push(rowCells(lines[j]));
        j++;
      }
      out.push("<table class='md-table'><thead><tr>" +
        header.map((c, k) => `<th${cellStyle(aligns[k])}>${inline(c)}</th>`).join("") +
        "</tr></thead>");
      if (body.length) {
        out.push("<tbody>" +
          body.map((r) => "<tr>" +
            header.map((_, k) => `<td${cellStyle(aligns[k])}>${inline(r[k] || "")}</td>`).join("") +
            "</tr>").join("") +
          "</tbody>");
      }
      out.push("</table>");
      i = j - 1;
      continue;
    }

    // blockquote
    if (ln.startsWith("> ")) {
      closeL();
      out.push(`<blockquote>${inline(ln.slice(2))}</blockquote>`);
      continue;
    }

    // 清單
    const li = ln.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push("<li>" + inline(li[1]) + "</li>");
      continue;
    }

    // 空行
    if (ln.trim() === "") {
      closeL();
      continue;
    }

    // 普通段落
    closeL();
    out.push("<p>" + inline(ln) + "</p>");
  }

  closeL();
  if (inCode)
    out.push(
      "<pre class='code'><code>" + esc(buf.join("\n")) + "</code></pre>"
    );
  return out.join("");
};

/* ── 9. 彩色 diff ─────────────────────────────────────── */
const diffHtml = (d) => {
  if (!d) return "";
  if (d.tooBig)
    return `<div class="diff"><div class="dh">+${d.added} -${d.removed} 行（差異過大，省略）</div></div>`;
  const ch = (d.lines || []).filter((l) => l.t !== " ").slice(0, 40);
  if (!ch.length) return "";
  return `<div class="diff"><div class="dh">+${d.added} -${d.removed}</div>${ch
    .map((l) => `<div class="dl ${l.t === "+" ? "add" : "del"}">${esc(l.t + " " + l.s)}</div>`)
    .join("")}</div>`;
};

/* ── 10. IME 組字保護 ─────────────────────────────────── */
/**
 * 防止中文/日文輸入法組字時，輪詢重繪把未確認的拼音洗掉。
 * @param {HTMLInputElement|HTMLTextAreaElement} el
 */
const wireComposition = (el) => {
  if (!el) return;
  let composing = false;
  el.addEventListener("compositionstart", () => {
    composing = true;
  });
  el.addEventListener("compositionend", () => {
    composing = false;
  });
  return () => composing; // 回傳 getter
};

/* ── 11. 工具函式 ─────────────────────────────────────── */

/** 格式化時間（相對新近）*/
const fmtTime = (s) => {
  try {
    const d = new Date(s);
    const now = Date.now();
    const diff = now - d.getTime();

    // 1 分鐘內
    if (diff < 60_000) return "剛剛";
    // 1 小時內
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分前`;
    // 今天
    if (diff < 86_400_000)
      return d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
    // 本週內
    if (diff < 604_800_000)
      return d.toLocaleDateString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
    // 其他
    return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  } catch {
    return "";
  }
};

/** 格式化檔案大小 */
const fmtSize = (n) => {
  if (n < 1024) return n + " B";
  if (n < 1_048_576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1_048_576).toFixed(1) + " MB";
};

/* ── 12. 領域選單 ─────────────────────────────────────── */
/** 渲染領域下拉選單到指定 select 元素（預設「自動」）*/
const renderPackSelect = (selectEl = $("#pack")) => {
  if (!selectEl) return;
  selectEl.innerHTML =
    `<option value="auto" selected title="依你的願望文字自動挑領域">🪄 自動判斷</option>` +
    PACKS.map((p) => {
      const d = packDesc(p);
      return `<option value="${p}"${d ? ` title="${esc(d)}"` : ""}>${packLabel(p)}${d ? " — " + esc(d) : ""}</option>`;
    }).join("");
};
