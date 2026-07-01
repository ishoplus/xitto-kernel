// GAIA 官方評分器（忠實移植自 GAIA benchmark 的 question_scorer）。
// 規則：ground truth 是數字 → 數值比對（去 $ % ,）；含逗號/分號 → 視為 list 逐項比對；
// 否則 → 字串正規化（去空白、小寫、去標點）後 exact match。
// 參考：huggingface.co/spaces/gaia-benchmark（scorer.py）。

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

// Python float() 語義：可解析成有限數字（含 1e5、.5、-3；不含空字串、'1,000'、'inf' 視情況）
export function isFloat(s) {
  const t = String(s).trim();
  if (t === '') return false;
  const n = Number(t);
  return Number.isFinite(n);
}

// 去 $ % , 後轉數字；失敗回 Infinity（比對必不相等）
export function normalizeNumberStr(s) {
  let x = String(s);
  for (const c of ['$', '%', ',']) x = x.split(c).join('');
  const t = x.trim();
  if (t === '') return Infinity;
  const n = Number(t);
  return Number.isNaN(n) ? Infinity : n;
}

// 去所有空白 + 小寫（+ 可選去標點）
export function normalizeStr(s, removePunct = true) {
  let x = String(s).replace(/\s/g, '').toLowerCase();
  if (removePunct) x = x.replace(PUNCT, '');
  return x;
}

export const splitString = (s) => String(s).split(/[,;]/);

/**
 * GAIA exact-match 評分。
 * @param {string} modelAnswer  模型的最終答案（已抽出 FINAL ANSWER 之後的內容）
 * @param {string} groundTruth  標準答案
 * @returns {boolean}
 */
export function questionScorer(modelAnswer, groundTruth) {
  const gt = String(groundTruth);
  // ① 數字
  if (isFloat(gt)) return normalizeNumberStr(modelAnswer) === Number(gt.trim());
  // ② list（含 , 或 ;）：逐項比對，數字項用數值、字串項用正規化（保留標點）
  if (/[,;]/.test(gt)) {
    const gtE = splitString(gt);
    const maE = splitString(String(modelAnswer));
    if (gtE.length !== maE.length) return false;
    return gtE.every((g, i) => {
      if (isFloat(g)) return normalizeNumberStr(maE[i]) === Number(g.trim());
      return normalizeStr(maE[i], false) === normalizeStr(g, false);
    });
  }
  // ③ 一般字串
  return normalizeStr(modelAnswer) === normalizeStr(gt);
}

// 從 agent 的最終文字抽出「FINAL ANSWER: ...」（取最後一次出現、該行內容）。抽不到就回整段 trim。
export function extractFinalAnswer(text) {
  const s = String(text || '');
  const re = /FINAL ANSWER:\s*(.*)/gi;
  let m, last = null;
  while ((m = re.exec(s)) !== null) last = m[1];
  if (last == null) return s.trim();
  return last.split('\n')[0].trim().replace(/[.]+$/, '').trim();
}
