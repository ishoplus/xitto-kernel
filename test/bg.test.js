// 後台進程 bash_bg / bash_output / bash_kill。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundTools } from '../src/kernel/bg.js';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const parse = (r) => JSON.parse(r.content[0].text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('coding pack 註冊後台工具 + metadata', () => {
  const k = createKernel(createCodingPack());
  assert.ok(k.registry.has('bash_bg') && k.registry.has('bash_output') && k.registry.has('bash_kill'));
  assert.ok([...k.mutatingTools].includes('bash_bg'));         // 啟動進程 → mutating
  assert.ok(k.registry.readOnlyNames().includes('bash_output'));
});

test('bash_bg → 輸出累積 → bash_output 讀到 → 結束', async () => {
  const { tools } = createBackgroundTools(process.cwd());
  const bg = Object.fromEntries(tools.map((t) => [t.name, t]));
  const start = parse(await bg.bash_bg.execute('1', { command: 'echo hello-bg; echo line2' }));
  assert.equal(start.status, 'running');
  await sleep(300);
  const out = parse(await bg.bash_output.execute('2', { id: start.id }));
  assert.match(out.output, /hello-bg/);
  assert.match(out.output, /line2/);
});

test('bash_bg 常駐 → bash_kill 終止', async () => {
  const { tools } = createBackgroundTools(process.cwd());
  const bg = Object.fromEntries(tools.map((t) => [t.name, t]));
  const start = parse(await bg.bash_bg.execute('1', { command: 'sleep 30' }));
  const killed = parse(await bg.bash_kill.execute('2', { id: start.id }));
  assert.equal(killed.killed, true);
});

test('bash_output / bash_kill 找不到 id → 友善回報', async () => {
  const { tools } = createBackgroundTools(process.cwd());
  const bg = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.match(parse(await bg.bash_output.execute('1', { id: 'nope' })).error, /找不到/);
  assert.match(parse(await bg.bash_kill.execute('2', { id: 'nope' })).error, /找不到/);
});
