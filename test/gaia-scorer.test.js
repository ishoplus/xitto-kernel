// GAIA 官方評分器移植的正確性（數字/list/字串三分支 + FINAL ANSWER 抽取）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionScorer, extractFinalAnswer, normalizeStr, normalizeNumberStr } from '../bench/gaia/scorer.mjs';

test('questionScorer：數字（去 $ % , / 空白，數值相等）', () => {
  assert.equal(questionScorer('42', '42'), true);
  assert.equal(questionScorer('  42 ', '42'), true);
  assert.equal(questionScorer('$1,234', '1234'), true);
  assert.equal(questionScorer('89%', '89'), true);
  assert.equal(questionScorer('43', '42'), false);
});

test('questionScorer：字串（去空白/小寫/去標點）', () => {
  assert.equal(questionScorer('Tunis', 'tunis'), true);
  assert.equal(questionScorer('New York.', 'new york'), true);
  assert.equal(questionScorer('Paris', 'London'), false);
});

test('questionScorer：list（逗號分隔，逐項、順序敏感、數量需相符）', () => {
  assert.equal(questionScorer('Mercury, Venus', 'Mercury, Venus'), true);
  assert.equal(questionScorer('mercury,venus', 'Mercury, Venus'), true);
  assert.equal(questionScorer('Venus, Mercury', 'Mercury, Venus'), false); // 順序不同
  assert.equal(questionScorer('Mercury', 'Mercury, Venus'), false);        // 數量不符
  assert.equal(questionScorer('1, 2, 3', '1,2,3'), true);                  // 數字 list
});

test('extractFinalAnswer：取最後一次 FINAL ANSWER 的該行內容', () => {
  assert.equal(extractFinalAnswer('思考...\nFINAL ANSWER: 42'), '42');
  assert.equal(extractFinalAnswer('FINAL ANSWER: Tunis.'), 'Tunis');
  assert.equal(extractFinalAnswer('FINAL ANSWER: a\n後面\nFINAL ANSWER: b'), 'b'); // 取最後一次
  assert.equal(extractFinalAnswer('沒有標記，整段回'), '沒有標記，整段回');
});

test('extractFinalAnswer：容忍模型的 markdown 粗體（**FINAL ANSWER:** / **7**）', () => {
  assert.equal(extractFinalAnswer('**FINAL ANSWER:** 7'), '7');
  assert.equal(extractFinalAnswer('FINAL ANSWER: **7**'), '7');
  assert.equal(extractFinalAnswer('**FINAL ANSWER:** Mercury, Venus'), 'Mercury, Venus');
  assert.equal(extractFinalAnswer('推理…\n**FINAL ANSWER:** `Apollo 11`'), 'Apollo 11');
});

test('normalize 輔助函數', () => {
  assert.equal(normalizeStr('New York!'), 'newyork');
  assert.equal(normalizeStr('New York!', false), 'newyork!');
  assert.equal(normalizeNumberStr('$1,000'), 1000);
  assert.equal(normalizeNumberStr('abc'), Infinity);
});
