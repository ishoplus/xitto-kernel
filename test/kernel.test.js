// kernel 組裝整合測試 — 證明同一個 kernel 跑兩個領域、守衛真實生效、kernel 零領域知識。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, detectLang, langDirectiveFor } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';
import { createDataQueryPack } from '../src/packs/data-query/index.js';

test('coding pack：mutatingTools 從工具 metadata 推導', () => {
  const k = createKernel(createCodingPack());
  assert.deepEqual([...k.mutatingTools].sort(), ['bash', 'bash_bg', 'edit', 'git_commit', 'lsp_rename', 'marketplace_add', 'skill_run', 'write']);
  // pack 的唯讀工具（kernel 另注入 memory_save/memory_list，故用 subset 檢查）
  for (const n of ['ls', 'read']) assert.ok(k.registry.readOnlyNames().includes(n));
  // kernel 內建記憶工具：任何 pack 都有
  assert.ok(k.registry.has('memory_save') && k.registry.has('memory_list'));
});

test('kernel：setModel/getModel 執行期切換 + compact 空歷史錯誤', async () => {
  const k = createKernel(createCodingPack(), { model: { id: 'm1', provider: 'p', contextWindow: 1000 }, getApiKey: async () => 'k' });
  assert.equal(k.getModel().id, 'm1');
  assert.equal(k.setModel({ id: 'm2', provider: 'p', contextWindow: 2000 }).id, 'm2');
  assert.equal(k.getModel().id, 'm2', 'setModel 後 getModel 反映新 model');
  // compact 歷史太少 → 錯誤，不呼叫 LLM
  assert.equal((await k.compact([])).error, 'nothing-to-compact');
});

test('coding pack：read-before-edit 真實生效（守衛 + 工具共享狀態）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k-coding-'));
  try {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello world');
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir });

    // 未先 read 就 edit → 被 read-before-edit 擋
    const blocked = await k.runTool('edit', { path: 'a.txt', oldText: 'hello', newText: 'hi' });
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason, /read-before-edit/);
    assert.equal(readFileSync(file, 'utf8'), 'hello world', '被擋時不該改檔');

    // 先 read，再 edit → 放行且真的改檔
    await k.runTool('read', { path: 'a.txt' });
    const ok = await k.runTool('edit', { path: 'a.txt', oldText: 'hello', newText: 'hi' });
    assert.ok(ok.result, '應執行成功');
    assert.equal(readFileSync(file, 'utf8'), 'hi world');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('data-query pack：同一個 kernel、零改動、不同領域（真實 sqlite）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dq-'));
  try {
    const k = createKernel(createDataQueryPack({ cwd: dir }), { cwd: dir });
    // 只有 sql_exec 是 mutating（sql_query 唯讀）→ 證明 metadata 推導跨領域通用
    assert.deepEqual([...k.mutatingTools], ['sql_exec', 'skill_run', 'marketplace_add']);

    // schema-before-query：未看 schema 先查 → 擋（對照 read-before-edit，同插槽不同領域）
    const blocked = await k.runTool('sql_query', { sql: 'SELECT 1' });
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason, /list_tables|describe_table/);

    // 看 schema 後放行；真實 sqlite：建表→寫入→查回
    await k.runTool('list_tables', {});
    await k.runTool('sql_exec', { sql: "CREATE TABLE t(id,name); INSERT INTO t VALUES(1,'amy'),(2,'bob');" });
    const q = await k.runTool('sql_query', { sql: 'SELECT count(*) AS n FROM t' });
    assert.match(q.result.content[0].text, /\b2\b/); // 真的查到 2 筆

    // sql_query 擋寫入型 SQL（政策收斂在守衛鏈第 3 格 → blocked，reason 導向 sql_exec）
    const w = await k.runTool('sql_query', { sql: 'DELETE FROM t' });
    assert.equal(w.blocked, true);
    assert.match(w.reason, /sql_exec/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('plan 模式擋 mutating 工具、放行唯讀', async () => {
  let plan = true;
  const dir = mkdtempSync(join(tmpdir(), 'k-plan-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, getPlanMode: () => plan });
    const w = await k.runTool('write', { path: 'x.txt', content: 'y' });
    assert.equal(w.blocked, true);
    assert.match(w.reason, /計劃模式/);
    const ls = await k.runTool('ls', { path: '.' });   // 唯讀仍放行
    assert.ok(ls.result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未知工具 → permission 擋下', async () => {
  const k = createKernel(createCodingPack());
  const r = await k.guardToolCall({ name: 'nope', args: {} });
  assert.equal(r.block, true);
  assert.match(r.reason, /未知工具/);
});

test('confirm 注入：mutating 工具拒絕則擋', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k-confirm-'));
  try {
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, confirm: async () => 'no' });
    const r = await k.runTool('write', { path: 'x.txt', content: 'y' });
    assert.equal(r.blocked, true);
    assert.match(r.reason, /拒絕/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 環境能力門控：不同環境（雲端/本機）只暴露該環境能用的工具/技能，並把邊界寫進 system prompt。
test('環境門控：caps/env 不滿足的 pack 工具不註冊，滿足的照常在', () => {
  const pack = {
    name: 'envpack', systemPrompt: 'x', tools: () => [
      { name: 'read_ws', readOnly: true, requires: ['workspaceFs'], description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) },
      { name: 'browse_host', readOnly: true, requires: ['hostFs'], description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) },
      { name: 'local_only', readOnly: true, env: 'local', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) },
    ],
  };
  // 雲端：有 workspaceFs、無 hostFs → read_ws 在、browse_host / local_only 被剔除
  const cloud = createKernel(pack, { caps: ['workspaceFs', 'shell'], env: 'cloud' });
  assert.ok(cloud.registry.has('read_ws'), '雲端應保留 workspace 工具（agent 可查看分配目錄）');
  assert.ok(!cloud.registry.has('browse_host'), '雲端缺 hostFs → 主機瀏覽工具不註冊');
  assert.ok(!cloud.registry.has('local_only'), 'env:local 工具在雲端不註冊');
  assert.deepEqual(cloud.env.droppedTools.sort(), ['browse_host', 'local_only']);
  // 本機：全能力 → 三個都在
  const localK = createKernel(pack, { caps: ['workspaceFs', 'hostFs', 'shell'], env: 'local' });
  for (const n of ['read_ws', 'browse_host', 'local_only']) assert.ok(localK.registry.has(n));
  // 未給 caps（CLI）→ 不門控，向後相容
  const cli = createKernel(pack);
  for (const n of ['read_ws', 'browse_host', 'local_only']) assert.ok(cli.registry.has(n));
});

test('環境門控：envNote 注入 system prompt', () => {
  const pack = { name: 'envpack2', systemPrompt: 'base', tools: () => [] };
  const k = createKernel(pack, { caps: ['workspaceFs'], env: 'cloud', envNote: '你運行在雲端託管容器。' });
  assert.match(k.systemPrompt, /運行環境/);
  assert.match(k.systemPrompt, /雲端託管容器/);
});

// 語系偵測與語言指令 — 對標 CC：可靠字形給具體指令、長尾語系跟隨使用者、中文分簡繁。
test('detectLang：日/韓假名諺文各自成語系', () => {
  assert.equal(detectLang('これはテストです'), 'ja');
  assert.equal(detectLang('안녕하세요 테스트'), 'ko');
});

test('detectLang：中文分簡/繁字體變體', () => {
  assert.equal(detectLang('查看kernel是否符合cc的多语言实现'), 'zh-Hans'); // 簡體專用字「实现语」
  assert.equal(detectLang('查看是否符合多語言實現'), 'zh-Hant');           // 繁體專用字「語實現」
  assert.equal(detectLang('你好嗎'), 'zh');                                // 字形共通 → 交模型鏡像
});

test('detectLang：拉丁/長尾語系不再硬鎖英文 → auto（CC 式跟隨）', () => {
  assert.equal(detectLang('Bonjour, peux-tu analyser ce fichier?'), 'auto'); // 法文不再變 en
  assert.equal(detectLang('Please review this code'), 'auto');               // 英文也走鏡像
});

test('langDirectiveFor：簡體使用者拿到簡體指令、非強制繁體', () => {
  assert.match(langDirectiveFor('zh-Hans'), /简体中文/);
  assert.ok(!/繁體/.test(langDirectiveFor('zh-Hans')), '簡體指令不應含繁體字樣');
  assert.match(langDirectiveFor('zh-Hant'), /繁體中文/);
  assert.match(langDirectiveFor('auto'), /Detect the language the user writes in/);
});

test('goal 模板：中文細分語系（zh-Hans/zh-Hant）走中文腳手架、不退英文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k-goallang-'));
  try {
    const model = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
    let firstUser = '';
    const fakeStream = (_m, ctx) => {
      // 捕獲首則 user 訊息 = goal 模板 start() 的產物 → 驗證其語言
      const u = (ctx.messages || []).find((m) => m.role === 'user');
      firstUser = (u?.content || []).filter?.((c) => c.type === 'text').map((c) => c.text).join('') || String(u?.content || '');
      const fin = { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input: 1, output: 1 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: fin }; }, result: async () => fin };
    };
    const k = createKernel(createCodingPack({ cwd: dir }), {
      cwd: dir, model, getApiKey: () => 'k', streamFn: fakeStream,
      checkGoal: async () => ({ done: true }), // 一輪即收，只看首則指令語言
    });
    // 簡體目標 → 中文腳手架（「目標：」），非英文「Goal:」
    await k.runGoal('幫我把这个整理成报告');
    assert.match(firstUser, /目標：/, '簡體目標應走中文 goal 模板');
    assert.ok(!/^Goal:/.test(firstUser), '不應退英文腳手架');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('時間注入（對標 CC）：每回合把宿主機當下日期＋時區注入 turn 的 systemPrompt；config.now/timezone 可覆寫', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k-time-'));
  try {
    const model = { id: 'x', provider: 'p', api: 'openai-completions', contextWindow: 1000 };
    let seen = '';
    const fakeStream = (_m, ctx) => {
      seen = ctx.systemPrompt;
      const fin = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', partial: fin }; }, result: async () => fin };
    };
    // 固定注入時間 + 時區 → 斷言 prompt 內出現該日期與時區（不受跑測試的機器時鐘/時區影響）
    const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, model, getApiKey: () => 'k', streamFn: fakeStream, now: '2026-07-08T02:00:00Z', timezone: 'Asia/Taipei' });
    await k.runTurn('現在幾點', {});
    assert.match(seen, /# 目前時間/);
    assert.match(seen, /今天是 2026-07-08/);
    assert.match(seen, /Asia\/Taipei/);
    assert.match(seen, /shell `date`/); // 導向工具取精確時間
    // 換時區：同一 UTC 時刻在紐約仍是 07-07（前一天晚上）→ 證明時區真的生效
    const k2 = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, model, getApiKey: () => 'k', streamFn: fakeStream, now: '2026-07-08T02:00:00Z', timezone: 'America/New_York' });
    await k2.runTurn('現在幾點', {});
    assert.match(seen, /今天是 2026-07-07/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
