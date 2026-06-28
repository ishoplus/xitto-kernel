// 寫檔限制在工作目錄內：成品不會跑到 /tmp、/app 等工作區外（修「報告顯示完成但檔案不在」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGeneralPack } from '../src/packs/general/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const result = (r) => JSON.parse(r.content[0].text);
const tool = (pack, name) => pack.tools().find((t) => t.name === name);

for (const [label, mk] of [['general', createGeneralPack], ['coding', createCodingPack]]) {
  test(`${label}：write 限制在工作目錄內（相對 OK、逃逸擋下）`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'xk-cf-'));
    try {
      const pack = mk({ cwd });
      const write = tool(pack, 'write');
      // 相對路徑 → 落在 cwd
      assert.ok(result(await write.execute('t', { path: 'report.md', content: 'hi' })).written);
      assert.ok(existsSync(join(cwd, 'report.md')));
      // 逃逸到工作區外（絕對路徑 /tmp）→ 擋下並回錯誤,不寫檔
      assert.match(result(await write.execute('t', { path: '/tmp/xk_esc_test.md', content: 'x' })).error, /只能寫在工作目錄內/);
      // 相對逃逸 ../ → 也擋
      assert.match(result(await write.execute('t', { path: '../escape.md', content: 'x' })).error, /只能寫在工作目錄內/);
      // /app 之類 → 也擋
      assert.match(result(await write.execute('t', { path: '/app/report.md', content: 'x' })).error, /只能寫在工作目錄內/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}
