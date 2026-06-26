import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeGuards } from '../src/kernel/guard-chain.js';

const block = (reason) => ({ block: true, reason });

test('全通過 → 放行（undefined）', async () => {
  const guard = composeGuards({
    planGuard: () => undefined,
    permission: async () => undefined,
  });
  assert.equal(await guard({ name: 'read' }), undefined);
});

test('固定順序執行；第一個 block 短路、後續不跑', async () => {
  const calls = [];
  const guard = composeGuards({
    planGuard: () => { calls.push('plan'); return undefined; },
    circuitBreaker: () => { calls.push('cb'); return block('熔斷'); },
    packPreTool: { check: () => { calls.push('pack'); return undefined; } },
    preToolHooks: () => { calls.push('hooks'); return undefined; },
    permission: async () => { calls.push('perm'); return undefined; },
  });
  const r = await guard({ name: 'write' });
  assert.deepEqual(r, block('熔斷'));
  assert.deepEqual(calls, ['plan', 'cb'], '熔斷後 pack/hooks/permission 不應執行');
});

test('pack 守衛在第 3 格（plan/cb 之後、hooks/permission 之前）', async () => {
  const calls = [];
  const guard = composeGuards({
    planGuard: () => { calls.push('plan'); return undefined; },
    circuitBreaker: () => { calls.push('cb'); return undefined; },
    packPreTool: { check: () => { calls.push('pack'); return block('read-before-edit'); } },
    preToolHooks: () => { calls.push('hooks'); return undefined; },
    permission: async () => { calls.push('perm'); return undefined; },
  });
  const r = await guard({ name: 'edit' });
  assert.equal(r.reason, 'read-before-edit');
  assert.deepEqual(calls, ['plan', 'cb', 'pack'], 'pack 應在 hooks/permission 之前擋下');
});

test('pack 守衛拿得到 services', async () => {
  let seen;
  const services = { cwd: '/work' };
  const guard = composeGuards({
    packPreTool: { check: (_ctx, svc) => { seen = svc; return undefined; } },
    services,
  });
  await guard({ name: 'x' });
  assert.equal(seen, services);
});

test('未提供的步驟自動略過（最小鏈）', async () => {
  const guard = composeGuards({ permission: async () => block('拒絕') });
  assert.deepEqual(await guard({ name: 'x' }), block('拒絕'));
});

test('permission 為 async 也正確等待', async () => {
  const guard = composeGuards({
    permission: async () => { await Promise.resolve(); return block('async 拒絕'); },
  });
  assert.deepEqual(await guard({ name: 'x' }), block('async 拒絕'));
});
