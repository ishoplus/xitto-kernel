// 技能管理端點 — 使用者可查看完整內容 / 刪除工作區結晶的技能。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerApp } from '../src/app/server.js';

const SKILL = '---\nname: my-skill\ndescription: 部署前跑測試\nusedCount: 3\n---\n\n## 步驟\n1. npm test\n';

async function withServer(fn) {
  const base = mkdtempSync(join(tmpdir(), 'sk-'));
  // 技能存於 <baseDir>/ws/default/.xitto-kernel/general/skills/<name>.md（託管模式 workspaceDir 規則）
  const skillsDir = join(base, 'ws', 'default', '.xitto-kernel', 'general', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, 'my-skill.md'), SKILL);
  const app = createServerApp({ model: { id: 'm', name: 'M', provider: 'p' }, getApiKey: () => 'k', token: 't', baseDir: base });
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port, U = (p) => `http://127.0.0.1:${port}${p}`;
  const H = { 'content-type': 'application/json', authorization: 'Bearer t' };
  try { await fn({ U, H, skillsDir }); } finally { await new Promise((r) => app.close(r)); rmSync(base, { recursive: true, force: true }); }
}

test('GET /v1/skills/body：回完整 markdown；需授權；未知 pack/name 擋掉', async () => {
  await withServer(async ({ U, H }) => {
    assert.equal((await fetch(U('/v1/skills/body?ws=default&pack=general&name=my-skill'))).status, 401, '無 token → 401');
    const r = await fetch(U('/v1/skills/body?ws=default&pack=general&name=my-skill'), { headers: H }).then((x) => x.json());
    assert.match(r.body, /部署前跑測試/);
    assert.match(r.body, /npm test/);
    assert.equal((await fetch(U('/v1/skills/body?ws=default&pack=nope&name=my-skill'), { headers: H })).status, 400, '未知 pack → 400');
    assert.equal((await fetch(U('/v1/skills/body?ws=default&pack=general&name=ghost'), { headers: H })).status, 404, '不存在的技能 → 404');
  });
});

test('POST /v1/skills/remove：刪除技能檔；需授權', async () => {
  await withServer(async ({ U, H, skillsDir }) => {
    assert.equal((await fetch(U('/v1/skills/remove'), { method: 'POST', body: JSON.stringify({ ws: 'default', pack: 'general', name: 'my-skill' }) })).status, 401);
    assert.ok(existsSync(join(skillsDir, 'my-skill.md')), '刪除前檔案在');
    const r = await fetch(U('/v1/skills/remove'), { method: 'POST', headers: H, body: JSON.stringify({ ws: 'default', pack: 'general', name: 'my-skill' }) }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.removed, 'my-skill');
    assert.ok(!existsSync(join(skillsDir, 'my-skill.md')), '刪除後檔案不在');
    // 再刪不存在 → 404
    assert.equal((await fetch(U('/v1/skills/remove'), { method: 'POST', headers: H, body: JSON.stringify({ ws: 'default', pack: 'general', name: 'my-skill' }) })).status, 404);
  });
});
