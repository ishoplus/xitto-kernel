// notes pack — 證明「新領域 = 只加一個 pack，kernel 零改動」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createNotesPack } from '../src/packs/notes/index.js';

test('notes pack：同一個 createKernel，第三個領域', () => {
  const k = createKernel(createNotesPack());
  assert.deepEqual([...k.mutatingTools], ['add_note']);           // 從 metadata 推導
  assert.deepEqual(k.registry.readOnlyNames().sort(), ['list_notes', 'read_note', 'search_notes']);
});

test('notes pack：search-before-add 守衛真實生效 + 工具真的存檔', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-'));
  try {
    const k = createKernel(createNotesPack({ cwd: dir }), { cwd: dir });

    // 未先 search 就 add → 擋（對照 read-before-edit / schema-before-query）
    const blocked = await k.runTool('add_note', { title: '購物清單', body: '牛奶' });
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason, /search_notes|list_notes/);

    // 先 search，再 add → 放行且真的存檔
    await k.runTool('search_notes', { query: '購物' });
    const ok = await k.runTool('add_note', { title: '購物清單', body: '牛奶' });
    assert.ok(ok.result);
    assert.ok(existsSync(join(dir, '.notes')), '應建立 .notes 目錄');

    // 讀得回來
    const read = await k.runTool('read_note', { title: '購物清單' });
    assert.match(read.result.content[0].text, /牛奶/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
