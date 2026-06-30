// 受保護目錄防護（沙箱靜態策略層）：禁止刪除/覆寫 .git / .xitto-* —— 但不誤傷 git 正常指令與讀取。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxViolation, PROTECTED_DIRS, normalizeSandbox, DEFAULT_SANDBOX } from '../src/kernel/security/sandbox.js';

const blocked = (cmd) => sandboxViolation(cmd) != null;

test('擋下：刪除受保護目錄', () => {
  assert.ok(blocked('rm -rf .git'));
  assert.ok(blocked('rm -rf ./.git/'));
  assert.ok(blocked('rmdir .xitto-kernel'));
  assert.ok(blocked('rm -rf .xitto-server/sessions'));
  assert.ok(blocked('unlink .git/index'));
  assert.ok(blocked('cd foo && rm -rf .git')); // 逐段切仍抓得到
});

test('擋下：覆寫進受保護目錄（重導/tee/dd）', () => {
  assert.ok(blocked('echo x > .git/config'));
  assert.ok(blocked('echo x >> .git/HEAD'));
  assert.ok(blocked('echo x | tee .xitto-kernel/skills/a.md'));
  assert.ok(blocked('dd if=/dev/zero of=.git/index'));
});

test('放行：git 正常 porcelain 與讀取（不誤傷）', () => {
  assert.equal(sandboxViolation('git commit -m "x"'), null);
  assert.equal(sandboxViolation('git add -A && git commit -m y'), null);
  assert.equal(sandboxViolation('git status'), null);
  assert.equal(sandboxViolation('cat .git/HEAD'), null);     // 讀取允許
  assert.equal(sandboxViolation('ls -la .git'), null);
});

test('放行：名稱相近但非受保護目錄（避免誤判）', () => {
  assert.equal(sandboxViolation('rm foo.gitignore'), null);   // .gitignore 不是 .git 分段
  assert.equal(sandboxViolation('rm -rf .github'), null);     // .github ≠ .git
  assert.equal(sandboxViolation('rm dist/app.gitx'), null);
  assert.equal(sandboxViolation('echo x > .gitlab-ci.yml'), null);
});

test('可設定 protectedDirs（空陣列 → 不擋）', () => {
  assert.equal(sandboxViolation('rm -rf .git', { protectedDirs: [] }), null);
  assert.ok(sandboxViolation('rm -rf secret', { protectedDirs: ['secret'] }) != null);
});

test('normalizeSandbox 帶出 protectedDirs 預設', () => {
  assert.deepEqual(normalizeSandbox(true).protectedDirs, PROTECTED_DIRS);
  assert.deepEqual(normalizeSandbox({ protectedDirs: ['.git'] }).protectedDirs, ['.git']);
  assert.deepEqual(normalizeSandbox({}).protectedDirs, DEFAULT_SANDBOX.protectedDirs);
});
