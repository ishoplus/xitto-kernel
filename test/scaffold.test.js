// 腳手架：證明產出的是「依賴 kernel 的獨立專案」，而非修改 kernel。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newAgent } from '../src/app/scaffold.js';

test('newAgent：產出完整獨立專案檔案', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scaf-'));
  try {
    const { target } = newAgent('my-bot', { dir });
    for (const f of ['package.json', 'index.js', 'pack.js', 'README.md', '.gitignore']) {
      assert.ok(existsSync(join(target, f)), `應產出 ${f}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('newAgent：package.json 用 file: 依賴 kernel（不固化的關鍵）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scaf2-'));
  try {
    const { target } = newAgent('my-bot', { dir, kernelPath: '/abs/kernel' });
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-bot');
    assert.equal(pkg.dependencies['xitto-kernel'], 'file:/abs/kernel');
    // index.js import kernel 的 app 子路徑（消費而非修改）
    assert.match(readFileSync(join(target, 'index.js'), 'utf8'), /from 'xitto-kernel\/app'/);
    // pack.js 已代換名稱
    assert.match(readFileSync(join(target, 'pack.js'), 'utf8'), /name: 'my-bot'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('newAgent：名稱不合法 / 目錄已存在 → 報錯', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scaf3-'));
  try {
    assert.throws(() => newAgent('bad name!', { dir }), /不合法/);
    newAgent('dup', { dir });
    assert.throws(() => newAgent('dup', { dir }), /已存在/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
