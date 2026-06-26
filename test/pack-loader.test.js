import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePack, loadPack } from '../src/kernel/pack-loader.js';

const minimal = () => ({ name: 'x', tools: () => [], systemPrompt: 'p' });

test('最小 pack（三必填）通過驗證', () => {
  assert.deepEqual(validatePack(minimal()), []);
  assert.equal(loadPack(minimal()).name, 'x');
});

test('缺必填欄位 → 各自報錯', () => {
  assert.match(validatePack({ tools: () => [], systemPrompt: 'p' }).join(), /name/);
  assert.match(validatePack({ name: 'x', systemPrompt: 'p' }).join(), /tools/);
  assert.match(validatePack({ name: 'x', tools: () => [] }).join(), /systemPrompt/);
});

test('非物件 / null → 報錯', () => {
  assert.deepEqual(validatePack(null), ['pack 必須是物件']);
  assert.deepEqual(validatePack(42), ['pack 必須是物件']);
});

test('選填欄位型別錯 → 報錯', () => {
  assert.match(validatePack({ ...minimal(), contextFiles: 'CLAUDE.md' }).join(), /contextFiles/);
  assert.match(validatePack({ ...minimal(), mutatingTools: [1, 2] }).join(), /mutatingTools/);
  assert.match(validatePack({ ...minimal(), verify: {} }).join(), /verify\.run/);
  assert.match(validatePack({ ...minimal(), preToolPolicy: {} }).join(), /preToolPolicy\.check/);
  assert.match(validatePack({ ...minimal(), permissionPolicy: 'x' }).join(), /permissionPolicy/);
});

test('選填欄位正確 → 通過', () => {
  assert.deepEqual(validatePack({
    ...minimal(),
    contextFiles: ['A.md'],
    mutatingTools: ['write'],
    verify: { run: async () => ({ ok: true }) },
    preToolPolicy: { check: () => undefined },
    permissionPolicy: { defaultMode: 'default' },
    memoryGuide: '提示',
  }), []);
});

test('loadPack 對不合法 pack 丟出聚合錯誤（含名稱）', () => {
  assert.throws(() => loadPack({ name: 'bad' }), /bad.*不合法[\s\S]*tools[\s\S]*systemPrompt/);
});
