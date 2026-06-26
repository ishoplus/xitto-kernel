// bash 沙箱 — 兩層防護：
//   (1) 靜態策略(sandboxViolation)：執行前正則分析命令字串，命中網路/提權/越界寫入即阻止。
//       快速、跨平台、給清楚理由；但靠字串分析，可被混淆/間接執行繞過(如 base64 解碼後執行)。
//   (2) OS 級真隔離(wrapWithSeatbelt)：macOS 用 sandbox-exec(Seatbelt) 把命令關進 OS 沙箱，
//       即使命令再怎麼混淆，越界寫入與網路都被核心擋死。非 macOS 自動降級為僅(1)。
// 兩層並存(defense in depth)：(1) 先擋明顯違規給好理由，(2) 兜住 (1) 漏網的混淆手法。
import { existsSync, realpathSync } from 'node:fs';

// 網路相關命令
const NET_RE = /\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp|telnet|rsync|ftp|svn)\b/;

// 預設允許寫入的絕對路徑前綴(其餘絕對路徑寫入視為違規；相對路徑視為工作目錄內，放行)
export const DEFAULT_SANDBOX = { enabled: false, blockNetwork: true, allowWritePrefixes: ['/tmp', '/private/tmp', '/var/folders'] };

function underAny(p, prefixes) {
  return prefixes.some((pre) => p === pre || p.startsWith(pre.endsWith('/') ? pre : pre + '/'));
}

// 回傳違規原因字串，無違規回 null。opts: { blockNetwork, allowWritePrefixes }
export function sandboxViolation(command, opts = {}) {
  const { blockNetwork = true, allowWritePrefixes = DEFAULT_SANDBOX.allowWritePrefixes } = opts;
  const cmd = String(command || '');
  if (!cmd.trim()) return null;
  const lc = cmd.toLowerCase();

  if (/(^|[\s;|&(])(sudo|doas)\s/.test(' ' + lc)) return '沙箱模式禁止 sudo/提權';
  if (blockNetwork && NET_RE.test(lc)) return '沙箱模式禁止網路命令（curl/wget/ssh/nc 等）';

  // 重定向寫入絕對路徑( > /etc/x、>> /usr/y )——不在允許前綴內即違規
  for (const m of cmd.matchAll(/>>?\s*"?(\/[^\s"'<>;|&]*)/g)) {
    if (!underAny(m[1], allowWritePrefixes)) return `沙箱模式禁止寫入工作目錄外：${m[1]}`;
  }
  // tee 寫入絕對路徑
  const tee = cmd.match(/\btee\b\s+(?:-a\s+)?"?(\/[^\s"'<>;|&]*)/);
  if (tee && !underAny(tee[1], allowWritePrefixes)) return `沙箱模式禁止 tee 寫入：${tee[1]}`;
  // dd of= 絕對路徑
  const dd = cmd.match(/\bof=\s*"?(\/[^\s"'<>;|&]*)/);
  if (dd && !underAny(dd[1], allowWritePrefixes)) return `沙箱模式禁止 dd 寫入：${dd[1]}`;

  return null;
}

// 把 settings.json 的 permissions.sandbox(boolean | 物件)正規化成 { enabled, blockNetwork, allowWritePrefixes }
export function normalizeSandbox(raw) {
  if (raw === true) return { ...DEFAULT_SANDBOX, enabled: true };
  if (raw && typeof raw === 'object') {
    return {
      enabled: raw.enabled !== false,
      blockNetwork: raw.blockNetwork !== false,
      allowWritePrefixes: Array.isArray(raw.allowWritePrefixes) ? raw.allowWritePrefixes : DEFAULT_SANDBOX.allowWritePrefixes,
    };
  }
  return { ...DEFAULT_SANDBOX };
}

// ── OS 級真隔離（macOS Seatbelt / sandbox-exec）────────────────────────────
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// 此平台是否能做 OS 級沙箱（目前僅 macOS 的 sandbox-exec）。非 macOS → false（降級為靜態策略）。
export function seatbeltAvailable() {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

// Seatbelt profile 字串字面值轉義（profile 用 "..." 包路徑，需轉義 " 與 \）
const sbStr = (p) => '"' + String(p).replace(/(["\\])/g, '\\$1') + '"';
// bash 單引號轉義：把 ' 換成 '\''（讓任意內容能安全塞進 '...' ）
const shq = (s) => `'` + String(s).replace(/'/g, `'\\''`) + `'`;

// 把路徑展開成「原值 + 符號連結解析後的真實路徑」兩者（去重）。
// macOS 上 /tmp→/private/tmp、/var→/private/var；Seatbelt 以核心解析後的真實路徑比對，
// 故 profile 必須含真實路徑，否則 cwd 在 /var/folders 下的寫入會被誤擋。
function canonicalPaths(paths) {
  const out = new Set();
  for (const p of paths) {
    if (!p) continue;
    out.add(p);
    try { out.add(realpathSync(p)); } catch { /* 路徑不存在 → 只保留原值 */ }
  }
  return [...out];
}

// 產生 Seatbelt profile：預設允許一切，再「減去」網路與工作目錄外的寫入。
// 讀取/執行不限制（建置常需讀系統庫）；寫入只放行 cwd + allowWritePrefixes + /dev（/dev/null 等）。
export function seatbeltProfile({ cwd, allowWritePrefixes = DEFAULT_SANDBOX.allowWritePrefixes, blockNetwork = true } = {}) {
  const prefixes = canonicalPaths([cwd, ...(allowWritePrefixes || []), '/dev']);
  const writeRules = prefixes.map((p) => `    (subpath ${sbStr(p)})`).join('\n');
  return [
    '(version 1)',
    '(allow default)',                       // 基準放行，後面的 deny 覆蓋之（規則後者優先）
    ...(blockNetwork ? ['(deny network*)'] : []),
    '(deny file-write*)',                    // 先擋所有寫入
    '(allow file-write*',                    // 再放行 cwd / 暫存 / /dev 內的寫入
    writeRules,
    ')',
    '',
  ].join('\n');
}

// 把命令包進 Seatbelt（sandbox-exec -p，profile 內聯、不留暫存檔）。
// 回傳改寫後可直接交給 shell 執行的命令字串；非 macOS / 無 sandbox-exec / 空命令 / 無 cwd → 回 null
// （呼叫端據此跑原命令，行為不變）。profile 與 sandboxViolation 共用同一組策略欄位，兩層一致。
export function wrapWithSeatbelt(command, { cwd, cfg = {} } = {}) {
  const cmd = String(command || '');
  if (!cmd.trim() || !cwd || !seatbeltAvailable()) return null;
  const profile = seatbeltProfile({
    cwd,
    allowWritePrefixes: cfg.allowWritePrefixes || DEFAULT_SANDBOX.allowWritePrefixes,
    blockNetwork: cfg.blockNetwork !== false,
  });
  return `${SANDBOX_EXEC} -p ${shq(profile)} /bin/bash -c ${shq(cmd)}`;
}
