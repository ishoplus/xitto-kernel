// 靜態程式碼品質/清理檢查 — 移植 Claude Code code-review/simplify 的「可靜態偵測」子集：
// 留下的除錯輸出、被吞掉的錯誤、鬆散比較、殘留標記等。深層語意 bug（邏輯錯、邊界、競態）
// 需 agent 自行審查，非靜態工具能涵蓋——本模組只做高訊號、低誤報的機械式檢查。
// 與 security-scan.js 互補：一個管安全、一個管品質。純函式、零依賴，供 code_review 工具與測試共用。

// 通用規則（跨語言，樣式夠獨特不會誤傷）
const UNIVERSAL = [
  {
    id: 'leftover-debug', sev: 'low',
    re: /\bconsole\.(log|debug|trace)\s*\(|\bdebugger\b|\bpdb\.set_trace\s*\(|(^|\s)breakpoint\s*\(\s*\)|\bbinding\.pry\b|\bvar_dump\s*\(|\bdd\s*\(|\bfmt\.Print(ln|f)?\s*\(/,
    advice: '疑似留下的除錯輸出 / 中斷點，交付前移除。',
  },
  {
    id: 'swallowed-error', sev: 'medium',
    re: /catch\s*(\([^)]*\))?\s*\{\s*\}|except[^:]*:\s*pass\s*$|rescue\s*=>\s*\w*\s*end/,
    advice: '空的 catch / except:pass 會吞掉錯誤——至少記錄或處理，別靜默略過。',
  },
  {
    id: 'leftover-marker', sev: 'low',
    re: /(^|[^\w])(TODO|FIXME|HACK|XXX)\b/,
    advice: '殘留待辦 / 暫時性標記，交付前確認是否已處理。',
  },
];

// JS/TS 專屬規則（== / var 在 Python 等語言是合法的，不可跨語言套用）
const JS_ONLY = [
  {
    id: 'loose-equality', sev: 'low',
    re: /(?<![=!<>])==(?!=)|(?<![=!<>])!=(?!=)/,
    advice: 'JS 用 == / != 有隱式轉型風險，改用 === / !==。',
  },
  {
    id: 'var-declaration', sev: 'low',
    re: /(^|[^.\w$])var\s+[a-zA-Z_$]/,
    advice: '用 let / const 取代 var（區塊作用域，避免變數提升陷阱）。',
  },
];

const SEV_RANK = { high: 3, medium: 2, low: 1 };
export function qualityRank(s) { return SEV_RANK[s] || 0; }

// 由副檔名判語言（決定要不要套 JS 專屬規則）
export function langOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = m ? m[1] : '';
  if (/^(js|jsx|mjs|cjs|ts|tsx|vue|svelte|astro)$/.test(e)) return 'js';
  if (/^(py|pyi)$/.test(e)) return 'py';
  return e;
}

// 掃描一段程式碼，回傳 findings：[{ line, rule, severity, advice, snippet }]。
// lang（由 langOf 得）決定是否套 JS 專屬規則。
export function scanQuality(text, lang = '') {
  const rules = lang === 'js' ? UNIVERSAL.concat(JS_ONLY) : UNIVERSAL;
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    for (const r of rules) {
      if (r.re.test(ln)) out.push({ line: i + 1, rule: r.id, severity: r.sev, advice: r.advice, snippet: ln.trim().slice(0, 180) });
    }
  }
  return out;
}
