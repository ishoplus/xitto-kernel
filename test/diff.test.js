// 彩色 diff：lineDiff(LCS) + diffBlock 渲染 + kernel 改檔自動掛 _diff。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lineDiff } from '../src/kernel/diff.js';
import { diffBlock } from '../src/app/tui-run.js';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const strip = (s) => s.replace(/\x1b\[[0-9]+m/g, '');

test('lineDiff：改動 → +/- 行；無變化 → null', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nb\nc'), null);
  const d = lineDiff('a\nb\nc', 'a\nB\nc');
  assert.equal(d.added, 1); assert.equal(d.removed, 1);
  assert.ok(d.lines.some((l) => l.t === '-' && l.s === 'b'));
  assert.ok(d.lines.some((l) => l.t === '+' && l.s === 'B'));
  // 新檔（before=null）→ 全部 +
  const nw = lineDiff(null, 'x\ny');
  assert.equal(nw.added, 2); assert.equal(nw.removed, 0);
});

test('lineDiff：超大檔 → tooBig（不展開內容）', () => {
  const big = Array.from({ length: 700 }, (_, i) => 'L' + i).join('\n');
  const d = lineDiff('', big);
  assert.ok(d.tooBig);
  assert.equal(d.added, 700);
});

test('diffBlock：渲染綠 + / 紅 - + 計數', () => {
  const out = strip(diffBlock(lineDiff('a\nb', 'a\nB')));
  assert.match(out, /\+1 -1 行/);
  assert.match(out, /\+ B/);
  assert.match(out, /- b/);
  assert.equal(diffBlock(null), '');
  assert.match(strip(diffBlock({ tooBig: true, added: 700, removed: 0 })), /差異過大/);
});

test('kernel：edit 改檔後 result 自動掛 _diff（集中於 wrapUndo,pack 免改）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'xk-diff-'));
  try {
    writeFileSync(join(cwd, 'f.txt'), 'hello\nworld');
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model: { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 }, getApiKey: () => 'k' });
    await k.runTool('read', { path: 'f.txt' });                 // edit 前需先 read（pack 規則）
    const r = await k.runTool('edit', { path: 'f.txt', oldText: 'world', newText: '世界' });
    assert.ok(r.result._diff, 'edit 結果應掛 _diff');
    assert.equal(r.result._diff.added, 1);
    assert.equal(r.result._diff.removed, 1);
    assert.match(strip(diffBlock(r.result._diff)), /\+ hello\n世界|世界/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
