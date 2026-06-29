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
 * 支援：h1-h4, p, ul/ol, code, pre, strong, em, a, blockquote。
 * 不足：表格、task list、巢狀列表。
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

  for (const ln of lines) {
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
    `<option value="auto" selected>🪄 自動判斷</option>` +
    PACKS.map((p) => `<option value="${p}">${packLabel(p)}</option>`).join("");
};
