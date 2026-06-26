// coding pack 的 git 工具 — 在臨時 git 倉庫驗證 status / commit / log（kernel 不認識 git）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const initRepo = (dir) => {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t.co && git config user.name t', { cwd: dir });
};

test('git 工具註冊（status/diff/log readOnly、commit mutating）', () => {
  const k = createKernel(createCodingPack());
  for (const n of ['git_status', 'git_diff', 'git_log', 'git_commit']) assert.ok(k.registry.has(n), n);
  assert.ok(k.registry.readOnlyNames().includes('git_status'));
  assert.ok([...k.mutatingTools].includes('git_commit'));
});

test('git_status / git_commit / git_log 在真實倉庫', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-'));
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });

    const st = await k.runTool('git_status', {});
    assert.match(st.result.content[0].text, /a\.txt/);

    const cm = await k.runTool('git_commit', { message: 'add a.txt', all: true });
    assert.doesNotMatch(JSON.stringify(cm.result), /error/);

    const log = await k.runTool('git_log', { n: 5 });
    assert.match(log.result.content[0].text, /add a\.txt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('非 git 倉庫 → 友善回報', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nogit-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });
    const st = await k.runTool('git_status', {});
    assert.match(JSON.stringify(st.result), /非 git 倉庫/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
