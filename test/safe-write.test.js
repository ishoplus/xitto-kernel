// 併發安全寫檔（shared/safe-write.js）+ general pack 寫入路徑的陳舊防護回歸測試。
// 場景動機：會議室多人共享同一 workspace、每人一條並發 AI lane（見 room-multiuser-ai 設計）——
//   別條 lane 在你 read 之後改了檔，你的整檔 write 不該把對方更新蓋掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markRead, writeAtomic } from '../src/packs/shared/safe-write.js';
import { createGeneralPack } from '../src/packs/general/index.js';

const mkdir = () => mkdtempSync(join(tmpdir(), 'safe-write-'));
// 把檔案 mtime 往未來推一秒 → 穩定模擬「被別人改動」，不受同毫秒寫入的解析度影響。
const bumpMtime = (p) => { const t = statSync(p).mtimeMs / 1000 + 1; utimesSync(p, t, t); };

test('writeAtomic：原子寫入、回 ok、更新基準表', () => {
  const dir = mkdir();
  const map = new Map();
  const p = join(dir, 'a.txt');
  const r = writeAtomic(map, p, 'hello', true); // 新檔（map 無基準）→ 直接寫
  assert.deepEqual(r, { ok: true });
  assert.equal(readFileSync(p, 'utf8'), 'hello');
  assert.equal(map.get(p), statSync(p).mtimeMs); // 寫後基準已更新
  rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic：連續（非陳舊）覆寫同一檔 → 都成功，不誤判', () => {
  const dir = mkdir();
  const map = new Map();
  const p = join(dir, 'a.txt');
  writeAtomic(map, p, 'v1', true);
  const r = writeAtomic(map, p, 'v2', true); // 自己剛寫過，基準是自己 → 不算陳舊
  assert.deepEqual(r, { ok: true });
  assert.equal(readFileSync(p, 'utf8'), 'v2');
  rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic(checkStale)：read 後檔案被改動 → 擋，且不覆寫', () => {
  const dir = mkdir();
  const map = new Map();
  const p = join(dir, 'shared.txt');
  writeFileSync(p, 'A 的原稿', 'utf8');
  markRead(map, p);          // 本回合讀到此檔（記下 mtime 基準）
  bumpMtime(p);              // 別條 lane 改了它（mtime 前進）
  const r = writeAtomic(map, p, '我基於舊稿的整檔覆寫', true);
  assert.deepEqual(r, { stale: true });               // 被擋
  assert.equal(readFileSync(p, 'utf8'), 'A 的原稿');   // 對方內容未被蓋
  rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic：checkStale=false（edit 用）→ 即使 mtime 前進也照寫（edit 已重讀最新內容）', () => {
  const dir = mkdir();
  const map = new Map();
  const p = join(dir, 'a.txt');
  writeFileSync(p, 'x', 'utf8');
  markRead(map, p);
  bumpMtime(p);
  const r = writeAtomic(map, p, 'y'); // 不檢查陳舊
  assert.deepEqual(r, { ok: true });
  assert.equal(readFileSync(p, 'utf8'), 'y');
  rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic：不留 .tmp 殘檔（rename 已消耗），且 tmp 名唯一', () => {
  const dir = mkdir();
  const map = new Map();
  // 對同一新檔連寫兩次：若 tmp 名只用 pid 會相撞；序號化後各自獨立、寫完皆 rename 消失。
  writeAtomic(map, join(dir, 'n.txt'), '1');
  writeAtomic(map, join(dir, 'n.txt'), '2');
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), []); // 無殘留 tmp
  rmSync(dir, { recursive: true, force: true });
});

test('general pack write：read 後被改動 → 拒絕覆寫（會議室併發保護）', async () => {
  const dir = mkdir();
  const pack = createGeneralPack({ cwd: dir });
  const tools = Object.fromEntries(pack.tools().map((t) => [t.name, t]));
  const p = join(dir, 'doc.md');
  writeFileSync(p, '# 原稿', 'utf8');
  await tools.read.execute('1', { path: 'doc.md' }); // 本回合讀過
  bumpMtime(p);                                       // 模擬別條 lane 改動
  const res = await tools.write.execute('2', { path: 'doc.md', content: '整檔覆寫' });
  const out = JSON.parse(res.content[0].text);
  assert.ok(out.error && /被改動/.test(out.error));    // 被擋
  assert.equal(readFileSync(p, 'utf8'), '# 原稿');      // 未覆寫
  rmSync(dir, { recursive: true, force: true });
});

test('general pack write：正常建新檔 / read 後未變動 → 照常成功', async () => {
  const dir = mkdir();
  const pack = createGeneralPack({ cwd: dir });
  const tools = Object.fromEntries(pack.tools().map((t) => [t.name, t]));
  const r1 = JSON.parse((await tools.write.execute('1', { path: 'new.md', content: 'hi' })).content[0].text);
  assert.equal(r1.written, 'new.md');
  await tools.read.execute('2', { path: 'new.md' });
  const r2 = JSON.parse((await tools.write.execute('3', { path: 'new.md', content: 'hi2' })).content[0].text);
  assert.equal(r2.written, 'new.md'); // read 後沒被別人動 → 可覆寫
  assert.equal(readFileSync(join(dir, 'new.md'), 'utf8'), 'hi2');
  rmSync(dir, { recursive: true, force: true });
});
