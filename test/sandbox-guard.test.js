// 守衛鏈第 5 格：真實 sandbox 接線測試。
// A 半部：靜態策略（網路/提權/危險命令）在 permission 步擋下。
// B 半部：OS 級 Seatbelt 在執行期擋下「靜態策略漏掉的混淆寫入」——這正是 OS 級隔離的價值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';
import { seatbeltAvailable } from '../src/kernel/security/sandbox.js';

const mk = (dir, over = {}) => createKernel(createCodingPack({ cwd: dir }), { cwd: dir, ...over });

test('A · 靜態策略：沙箱開 + 網路命令 → 第 5 格擋下（不執行）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-net-'));
  try {
    const r = await mk(dir, { sandbox: { enabled: true } }).runTool('bash', { command: 'curl http://evil' });
    assert.equal(r.blocked, true);
    assert.match(r.reason, /網路|沙箱/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A · 危險命令：headless 無 confirm → 一律擋（與沙箱開關無關）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-danger-'));
  try {
    // rm -rf 在 guard 就被擋，永不執行
    const r = await mk(dir).runTool('bash', { command: 'rm -rf /tmp/nonexistent-xitto-xyz' });
    assert.equal(r.blocked, true);
    assert.match(r.reason, /危險/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A · deny 規則：data-query 的 bash:DROP 被擋', async () => {
  const { createDataQueryPack } = await import('../src/packs/data-query/index.js');
  // 給 data-query 加一個 sandboxable 的 shell 工具不必要；改用 coding + 自訂 deny 驗證機制
  const dir = mkdtempSync(join(tmpdir(), 'sg-deny-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, sandbox: { enabled: false } });
    // coding pack 無 deny；改直接驗證 permission-step 的 deny 路徑（透過 pack.permissionPolicy）
    const k2 = createKernel({ ...createCodingPack({ cwd: dir }), permissionPolicy: { deny: ['bash:git push'] } }, { cwd: dir });
    const d = await k2.guardToolCall({ name: 'bash', args: { command: 'git push origin main' } });
    assert.equal(d.block, true);
    assert.match(d.reason, /deny/);
    void k; void createDataQueryPack;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('沙箱關（預設）：網路命令不被靜態策略擋（回一般流程）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-off-'));
  try {
    const d = await mk(dir).guardToolCall({ name: 'bash', args: { command: 'curl http://x' } });
    assert.equal(d, undefined); // 沙箱關 → 不擋（headless 放行）
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B · OS 級 Seatbelt：擋下「靜態策略漏掉的混淆越界寫入」', { skip: !seatbeltAvailable() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-os-'));
  const evil = join(homedir(), `kernel_sbx_test_${process.pid}.txt`);
  try {
    const k = mk(dir, { sandbox: { enabled: true } });
    // 經變數間接寫入：靜態正則找不到「> /literal/path」→ 通過第 5 格；但 OS Seatbelt 在執行期擋死
    const cmd = `P=${JSON.stringify(evil)}; echo x > "$P"`;
    const r = await k.runTool('bash', { command: cmd });
    assert.ok(r.result, '靜態策略漏掉 → guard 放行、進入執行');
    assert.equal(existsSync(evil), false, 'OS 層應擋下越界寫入，檔案不該存在');
    assert.match(JSON.stringify(r.result), /not permitted|Operation not permitted/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evil, { force: true });
  }
});

test('B · OS 級 Seatbelt：沙箱開時 cwd 內寫入仍成功', { skip: !seatbeltAvailable() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-in-'));
  try {
    const k = mk(dir, { sandbox: { enabled: true } });
    const r = await k.runTool('bash', { command: 'echo hi > inside.txt && cat inside.txt' });
    assert.match(JSON.stringify(r.result), /hi/);
    assert.equal(readFileSync(join(dir, 'inside.txt'), 'utf8').trim(), 'hi');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
