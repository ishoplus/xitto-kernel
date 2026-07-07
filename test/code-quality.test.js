// 靜態品質掃描（code-quality）+ coding pack 的 code_review 工具。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanQuality, langOf } from '../src/packs/shared/code-quality.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const rulesOf = (code, lang) => scanQuality(code, lang).map((f) => f.rule);

test('scanQuality：通用規則（除錯輸出/吞錯/殘留標記）跨語言命中', () => {
  assert.ok(rulesOf('console.log(x);', 'js').includes('leftover-debug'));
  assert.ok(rulesOf('  breakpoint()', 'py').includes('leftover-debug'));
  assert.ok(rulesOf('try { f() } catch (e) {}', 'js').includes('swallowed-error'));
  assert.ok(rulesOf('try:\n    f()\nexcept:  pass', 'py').includes('swallowed-error'));
  assert.ok(rulesOf('// TODO: 之後補', 'js').includes('leftover-marker'));
});

test('scanQuality：== / var 只對 JS，不誤傷 Python', () => {
  assert.ok(rulesOf('if (a == b) {}', 'js').includes('loose-equality'));
  assert.ok(rulesOf('var x = 1;', 'js').includes('var-declaration'));
  // Python 的 == 是合法的，不該報 loose-equality
  assert.ok(!rulesOf('if a == b:', 'py').includes('loose-equality'));
  assert.ok(!rulesOf('if a == b:', 'py').includes('var-declaration'));
  // === 不該報
  assert.ok(!rulesOf('if (a === b) {}', 'js').includes('loose-equality'));
});

test('langOf：副檔名 → 語言分類', () => {
  assert.equal(langOf('a.ts'), 'js');
  assert.equal(langOf('a.jsx'), 'js');
  assert.equal(langOf('a.py'), 'py');
  assert.equal(langOf('a.go'), 'go');
});

test('code_review 工具：審指定檔 → 回品質 findings（含行號/統計）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-'));
  try {
    writeFileSync(join(dir, 'x.js'), 'var a = 1;\nconsole.log(a);\nif (a == 1) {}\n// TODO fix\n');
    writeFileSync(join(dir, 'clean.js'), 'export const add = (a, b) => a + b;\n');
    const pack = createCodingPack({ cwd: dir });
    const tool = pack.tools().find((t) => t.name === 'code_review');
    assert.ok(tool, '應有 code_review 工具');

    const r = JSON.parse((await tool.execute('1', { paths: ['x.js'] })).content[0].text);
    assert.equal(r.scanned, 1);
    const rules = r.findings.map((f) => f.rule);
    assert.ok(rules.includes('var-declaration'));
    assert.ok(rules.includes('leftover-debug'));
    assert.ok(rules.includes('loose-equality'));
    assert.ok(rules.includes('leftover-marker'));

    const clean = JSON.parse((await tool.execute('2', { paths: ['clean.js'] })).content[0].text);
    assert.equal(clean.total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('security_review 與 code_review 並存於 coding pack', () => {
  const pack = createCodingPack({ cwd: '/tmp' });
  const names = pack.tools().map((t) => t.name);
  assert.ok(names.includes('security_review'));
  assert.ok(names.includes('code_review'));
});
