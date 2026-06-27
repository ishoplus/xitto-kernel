// 專案手冊（程序層沉澱）：topic 鍵控更新/去重、移除、清空、落地重載,以及注入 system prompt。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlaybook } from '../src/kernel/playbook.js';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'xk-pb-'));

test('update：新增 / 同 topic 覆蓋（去重）/ 同內容跳過', () => {
  const dir = tmp(); const file = join(dir, 'playbook.md');
  try {
    const pb = createPlaybook(file);
    assert.deepEqual(pb.update('測試', 'npm test'), { added: '測試' });
    assert.equal(pb.list().length, 1);
    // 同 topic（大小寫不敏感）→ 覆蓋,不新增
    assert.deepEqual(pb.update('測試', 'npm test；先設 OFFLINE=1'), { updated: '測試' });
    assert.equal(pb.list().length, 1);
    assert.match(pb.list()[0].note, /OFFLINE/);
    // 同內容 → 跳過
    assert.deepEqual(pb.update('測試', 'npm test；先設 OFFLINE=1'), { skipped: true, topic: '測試' });
    // 空值防呆
    assert.ok(pb.update('', 'x').error);
    assert.ok(pb.update('x', '').error);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('多 topic 並存 + remove + clear', () => {
  const dir = tmp(); const file = join(dir, 'playbook.md');
  try {
    const pb = createPlaybook(file);
    pb.update('測試', 'npm test');
    pb.update('建置', 'npm run build');
    pb.update('部署地雷', '先跑 migration 否則 500');
    assert.equal(pb.list().length, 3);
    assert.deepEqual(pb.remove('建置'), { removed: '建置' });
    assert.equal(pb.list().length, 2);
    assert.ok(pb.remove('不存在').error);
    assert.deepEqual(pb.clear(), { cleared: 2 });
    assert.equal(pb.list().length, 0);
    assert.equal(existsSync(file), false, '清空後刪檔');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('落地重載（跨 session）+ 檔案可讀', () => {
  const dir = tmp(); const file = join(dir, 'playbook.md');
  try {
    const pb1 = createPlaybook(file);
    pb1.update('測試', 'npm test');
    pb1.update('慣例', '用 2 空格縮排');
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, 'utf8'), /## 測試\nnpm test/);
    // 模擬重啟
    const pb2 = createPlaybook(file);
    const topics = pb2.list().map((e) => e.topic);
    assert.deepEqual(topics, ['測試', '慣例']);
    assert.equal(pb2.list()[1].note, '用 2 空格縮排');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('解析多行 note', () => {
  const dir = tmp(); const file = join(dir, 'playbook.md');
  try {
    const pb = createPlaybook(file);
    pb.update('部署', '1. 跑 migration\n2. 重啟服務\n3. 健康檢查');
    const e = pb.list()[0];
    assert.equal(e.topic, '部署');
    assert.match(e.note, /1\. 跑 migration/);
    assert.match(e.note, /3\. 健康檢查/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kernel：playbook 工具注入 + 既有手冊載入進 system prompt', () => {
  const cwd = tmp();
  try {
    const model = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
    const k = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k' });
    // 工具齊全
    assert.ok(k.registry.has('playbook_update'));
    assert.ok(k.registry.has('playbook_remove'));
    // 寫一條 → 新 kernel 應把它載進 system prompt
    k.playbook.update('測試', '跑 npm test 前先設 OFFLINE=1');
    const k2 = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey: () => 'k' });
    assert.match(k2.systemPrompt, /專案手冊/);
    assert.match(k2.systemPrompt, /OFFLINE=1/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
