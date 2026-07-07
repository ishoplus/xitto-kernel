// 靜態安全掃描（security-scan）+ coding pack 的 security_review 工具。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanCode, sortFindings, severityRank } from '../src/packs/shared/security-scan.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const rulesOf = (code) => scanCode(code).map((f) => f.rule);

test('scanCode：命中各類高風險樣式', () => {
  assert.ok(rulesOf('const apiKey = "sk-live-abcd1234efgh";').includes('hardcoded-secret'));
  assert.ok(rulesOf('const r = eval(userInput);').includes('eval-exec-code'));
  assert.ok(rulesOf('execSync("ls " + dir);').includes('shell-injection'));
  assert.ok(rulesOf('subprocess.run(cmd, shell=True)').includes('py-shell-injection'));
  assert.ok(rulesOf('db.query("SELECT * FROM u WHERE id=" + id)').includes('sql-injection'));
  assert.ok(rulesOf('el.innerHTML = userHtml;').includes('xss-innerhtml'));
  assert.ok(rulesOf('const a = { rejectUnauthorized: false };').includes('tls-verification-disabled'));
  assert.ok(rulesOf('crypto.createHash("md5")').includes('weak-hash'));
  assert.ok(rulesOf('data = pickle.loads(raw)').includes('unsafe-deserialization'));
});

test('scanCode：skip 規則排除明顯誤報（環境變數不算硬編碼）', () => {
  assert.ok(!rulesOf('const apiKey = process.env.API_KEY;').includes('hardcoded-secret'));
  assert.ok(!rulesOf('password = os.environ["PW"]').includes('hardcoded-secret'));
  // 安全的寫法不該誤報
  assert.deepEqual(scanCode('const x = textContent; el.textContent = x;'), []);
  assert.deepEqual(scanCode('db.query("SELECT * FROM u WHERE id=?", [id])'), []);
});

test('scanCode：附行號與嚴重度；sortFindings 高→低', () => {
  const code = 'line1\nconst apiKey = "sk-abcdefgh1234";\nel.innerHTML = x;';
  const f = scanCode(code);
  const secret = f.find((x) => x.rule === 'hardcoded-secret');
  assert.equal(secret.line, 2);
  assert.equal(secret.severity, 'high');
  const sorted = sortFindings(f);
  assert.ok(severityRank(sorted[0].severity) >= severityRank(sorted[sorted.length - 1].severity));
});

test('security_review 工具：審指定檔 → 回 findings（依嚴重度排序、含統計）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec-'));
  try {
    writeFileSync(join(dir, 'bad.js'), 'const token = "ghp_realsecret1234";\nexecSync("rm " + name);\n');
    writeFileSync(join(dir, 'good.js'), 'export const add = (a, b) => a + b;\n');
    const pack = createCodingPack({ cwd: dir });
    const tool = pack.tools().find((t) => t.name === 'security_review');
    assert.ok(tool, '應有 security_review 工具');

    const bad = JSON.parse((await tool.execute('1', { paths: ['bad.js'] })).content[0].text);
    assert.equal(bad.scanned, 1);
    assert.ok(bad.total >= 2);
    assert.ok(bad.bySeverity.high >= 2);
    assert.ok(bad.findings.every((f) => f.file === 'bad.js'));

    const good = JSON.parse((await tool.execute('2', { paths: ['good.js'] })).content[0].text);
    assert.equal(good.total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('security_review 工具：無變更 / 非 git → 友善提示，不報錯', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec2-'));
  try {
    const pack = createCodingPack({ cwd: dir });
    const tool = pack.tools().find((t) => t.name === 'security_review');
    const r = JSON.parse((await tool.execute('1', {})).content[0].text);
    assert.equal(r.scanned, 0);
    assert.match(r.note, /沒有可審查/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
