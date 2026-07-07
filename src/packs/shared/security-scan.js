// 靜態安全掃描 — 移植 Claude Code 的 security-review/security-guidance 精神：
// 對「程式碼變更」做逐行樣式檢查，找出常見高風險寫法。高訊號、低誤報為原則
// （只標真正值得人工確認的樣式；非全部即漏洞）。零依賴、純函式，供 coding pack 的
// security_review 工具與單元測試共用。
//
// 每條規則：{ id, sev, re, skip?, advice }。逐行比對 re（命中即一筆 finding），
// skip（可選）命中則略過該行（排除明顯誤報，如已用環境變數）。

const RULES = [
  {
    id: 'hardcoded-secret', sev: 'high',
    re: /\b(api[_-]?key|secret|password|passwd|pwd|token|access[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
    skip: /process\.env|import\.meta|getenv|os\.environ|\$\{|<%|placeholder|example|xxxx|process\.argv/i,
    advice: '疑似硬編碼機密。改用環境變數 / 密鑰管理，勿寫進原始碼或版控。',
  },
  {
    id: 'eval-exec-code', sev: 'high',
    re: /\beval\s*\(|new\s+Function\s*\(|\bexec\s*\(\s*compile\s*\(/,
    advice: 'eval / Function 動態執行程式碼。避免對不可信輸入使用，恐任意程式碼執行。',
  },
  {
    id: 'shell-injection', sev: 'high',
    re: /\b(exec|execSync|spawn|spawnSync)\s*\([^)]*(\$\{|['"`]\s*\+|\+\s*['"`]|shell\s*:\s*true)/,
    advice: 'shell 命令含變數插值或開啟 shell。恐命令注入；改用參數陣列並勿開 shell。',
  },
  {
    id: 'py-shell-injection', sev: 'high',
    re: /\bos\.(system|popen)\s*\(|subprocess\.(call|run|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True/,
    advice: 'os.system / shell=True 恐命令注入。改用 args list、shell=False。',
  },
  {
    id: 'sql-injection', sev: 'medium',
    re: /(["'`][^"'`]*\b(select|insert into|update|delete from|where)\b[^"'`]*["'`]\s*\+)|(\bf["'][^"']*\b(select|insert|update|delete)\b[^"']*\{)|(%\s*\([^)]*\)s?\s*%)/i,
    advice: 'SQL 以字串拼接 / f-string / % 格式化組成。恐 SQL 注入；改用參數化查詢 / 綁定參數。',
  },
  {
    id: 'xss-innerhtml', sev: 'medium',
    re: /\.innerHTML\s*=\s*(?!['"`]\s*[;<])|\bdangerouslySetInnerHTML\b|\.outerHTML\s*=\s*(?!['"`])/,
    advice: 'innerHTML 指派非字面值恐 XSS。改用 textContent，或先消毒（DOMPurify 等）。',
  },
  {
    id: 'tls-verification-disabled', sev: 'high',
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(0|false)/i,
    advice: '停用 TLS 憑證驗證，中間人攻擊風險。生產環境勿停用憑證驗證。',
  },
  {
    id: 'weak-hash', sev: 'low',
    re: /createHash\s*\(\s*['"](md5|sha1)['"]|\bhashlib\.(md5|sha1)\s*\(|\bMD5\b\s*\(|message-?digest.*md5/i,
    advice: 'MD5 / SHA-1 已不安全。雜湊敏感資料改用 SHA-256+；密碼用 bcrypt / argon2 / scrypt。',
  },
  {
    id: 'unsafe-deserialization', sev: 'medium',
    re: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Safe)|\bmarshal\.loads?\s*\(|readObject\s*\(/,
    advice: '對不可信資料反序列化恐遠端程式碼執行。用 yaml.safe_load / 白名單 / JSON。',
  },
  {
    id: 'insecure-random-secret', sev: 'low',
    re: /\bMath\.random\s*\(\)[^;]*\b(token|secret|password|nonce|salt|otp|session)\b|\b(token|secret|password|nonce|salt|otp)\b[^;]*Math\.random\s*\(\)/i,
    advice: 'Math.random 非密碼學安全。產生 token/密鑰改用 crypto.randomBytes / getRandomValues。',
  },
];

const SEV_RANK = { high: 3, medium: 2, low: 1 };
export function severityRank(s) { return SEV_RANK[s] || 0; }

// 掃描一段程式碼文字，回傳 findings：[{ line, rule, severity, advice, snippet }]
export function scanCode(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    for (const r of RULES) {
      if (r.skip && r.skip.test(ln)) continue;
      if (r.re.test(ln)) out.push({ line: i + 1, rule: r.id, severity: r.sev, advice: r.advice, snippet: ln.trim().slice(0, 180) });
    }
  }
  return out;
}

// 依嚴重度排序（高→低）；同級維持原順序（穩定）。
export function sortFindings(findings) {
  return [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}
