// 行級 diff（LCS）— 給 TUI/app 渲染彩色 diff。回傳 { lines:[{t,s}], added, removed } 或 { tooBig } 或 null（無變化）。
// kernel 在 wrapUndo 已抓到 before（undo 快照），改完讀 after，集中算 diff,所有 pack 的 edit/write 免改。
export function lineDiff(before, after, { maxLines = 600 } = {}) {
  if (before === after) return null;
  const a = before == null ? [] : String(before).replace(/\n$/, '').split('\n');
  const b = after == null ? [] : String(after).replace(/\n$/, '').split('\n');
  if (a.length === 1 && a[0] === '' && before == null) a.length = 0;
  if (b.length === 1 && b[0] === '' && after == null) b.length = 0;
  const m = a.length, n = b.length;
  if (m > maxLines || n > maxLines) return { tooBig: true, added: n, removed: m };

  // LCS DP（自後往前）
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const lines = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { lines.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ t: '-', s: a[i] }); i++; }
    else { lines.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < m) lines.push({ t: '-', s: a[i++] });
  while (j < n) lines.push({ t: '+', s: b[j++] });

  const added = lines.filter((l) => l.t === '+').length;
  const removed = lines.filter((l) => l.t === '-').length;
  if (!added && !removed) return null;
  return { lines, added, removed };
}
