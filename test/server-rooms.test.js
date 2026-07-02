// 專案會議室：@ai 觸發判定、房間 store（多人發言/廣播/回合制/續跑）、HTTP 端點。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore, mentionsAi, createServerApp, defaultAuth, createRoleStore, minutesGoal, lanIPs, joinUploadRel } from '../src/app/server.js';

const tick = () => new Promise((r) => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('mentionsAi：點名 @ai 才觸發（行首/空白/標點前綴）；非點名不觸發', () => {
  assert.equal(mentionsAi('@ai 幫我總結'), true);
  assert.equal(mentionsAi('大家好，@ai 你覺得呢'), true);
  assert.equal(mentionsAi('（@ai）'), true);
  assert.equal(mentionsAi('AI 幫忙'), false);        // 沒有 @
  assert.equal(mentionsAi('mail@ai.com'), false);    // email 不誤觸
  assert.equal(mentionsAi('隨便聊聊'), false);
  assert.equal(mentionsAi(''), false);
});

test('房間：建房 → 加入 → 發言即時廣播給全員', async () => {
  const store = createRoomStore({ runAiTurn: async () => ({ sessionId: 's1', text: 'hi' }) });
  const r = store.create({ workspace: 'proj', pack: 'general' });
  assert.ok(r.roomId);
  assert.equal(r.workspace, 'proj');
  const a = store.join(r.roomId, '小明');
  const b = store.join(r.roomId, '小華');
  assert.ok(a.memberId && b.memberId);
  const seenByB = [];
  store.subscribe(r.roomId, (ev) => seenByB.push(ev));
  const res = store.say(r.roomId, { memberId: a.memberId, text: '大家好' });
  assert.equal(res.ok, true);
  assert.equal(res.triggered, false); // 沒 @ai → 不觸發 AI
  assert.ok(seenByB.some((e) => e.type === 'say' && e.message.name === '小明' && e.message.text === '大家好'));
});

test('房間：發言必須先加入、不可為空', () => {
  const store = createRoomStore({ runAiTurn: async () => ({}) });
  const r = store.create({});
  assert.equal(store.say(r.roomId, { memberId: 'nope', text: 'x' }).code, 403);
  const u = store.join(r.roomId, 'x');
  assert.equal(store.say(r.roomId, { memberId: u.memberId, text: '   ' }).code, 400);
  assert.equal(store.say('no-such-room', { memberId: u.memberId, text: 'x' }).code, 404);
});

test('房間：@ai 觸發一輪 AI，串流事件與最終訊息都廣播；context 含先前閒聊', async () => {
  let capturedInput = null;
  const store = createRoomStore({
    runAiTurn: async ({ input, emit }) => {
      capturedInput = input;
      emit({ type: 'text', delta: '回覆' });
      emit({ type: 'text', delta: '完成' });
      return { sessionId: 'sess', text: '回覆完成' };
    },
  });
  const r = store.create({});
  const u = store.join(r.roomId, '小明');
  const evs = [];
  store.subscribe(r.roomId, (ev) => evs.push(ev));
  store.say(r.roomId, { memberId: u.memberId, text: '首頁要改版' });     // 閒聊，累積成 context
  const res = store.say(r.roomId, { memberId: u.memberId, text: '@ai 幫我彙整' }); // 召喚
  assert.equal(res.triggered, true);
  await tick(); await tick(); await tick();
  // 餵給 AI 的 input 應含兩則（先前閒聊也進 context）
  assert.match(capturedInput, /首頁要改版/);
  assert.match(capturedInput, /@ai 幫我彙整/);
  // 事件流：thinking → ai text → idle → 最終 AI 訊息
  assert.ok(evs.some((e) => e.type === 'status' && e.status === 'thinking'));
  assert.ok(evs.some((e) => e.type === 'ai' && e.ev.type === 'text'));
  assert.ok(evs.some((e) => e.type === 'status' && e.status === 'idle'));
  assert.ok(evs.some((e) => e.type === 'say' && e.message.kind === 'ai' && e.message.text === '回覆完成'));
  assert.equal(store.get(r.roomId).sessionId, 'sess'); // 首輪建立 sessionId → 續接
});

test('房間：餵給 AI 的 input 前置會議室情境 + 成員名單（L1 群聊感知）', async () => {
  let capturedInput = null;
  const store = createRoomStore({ runAiTurn: async ({ input }) => { capturedInput = input; return { sessionId: 's', text: 'r' }; } });
  const r = store.create({});
  const a = store.join(r.roomId, '小明');
  store.join(r.roomId, '小華');
  store.say(r.roomId, { memberId: a.memberId, text: '@ai 幫忙' });
  await tick(); await tick(); await tick();
  assert.match(capturedInput, /會議室情境/);
  assert.match(capturedInput, /小明/);          // 成員名單含兩位成員
  assert.match(capturedInput, /小華/);
  assert.match(capturedInput, /點名/);           // 多人 → 引導點名回覆
  // 情境在前、發話人前綴在後
  assert.ok(capturedInput.indexOf('會議室情境') < capturedInput.indexOf('[小明]'), '情境應在發言之前');
});

test('房間：AI 忙碌時的 @ai 不重疊；回合末自動續跑', async () => {
  const d1 = defer();
  let calls = 0;
  const inputs = [];
  const store = createRoomStore({
    runAiTurn: async ({ input }) => { calls++; inputs.push(input); if (calls === 1) await d1.promise; return { sessionId: 's', text: 'r' + calls }; },
  });
  const r = store.create({});
  const u = store.join(r.roomId, '小明');
  store.say(r.roomId, { memberId: u.memberId, text: '@ai 問題一' });
  await tick();
  assert.equal(calls, 1, '第一輪進行中');
  assert.equal(store.get(r.roomId).status, 'thinking');
  store.say(r.roomId, { memberId: u.memberId, text: '@ai 問題二' }); // 忙碌 → 不開新回合
  await tick();
  assert.equal(calls, 1, '不重疊：第二個 @ai 未立刻起跑');
  d1.resolve();
  await tick(); await tick(); await tick();
  assert.equal(calls, 2, '回合末偵測到待處理 @ai → 續跑');
  assert.match(inputs[1], /問題二/);
  assert.equal(store.get(r.roomId).status, 'idle');
});

test('房間：runAiTurn 拋錯 → 房間回 idle + 系統訊息，不卡死', async () => {
  const store = createRoomStore({ runAiTurn: async () => { throw new Error('boom'); } });
  const r = store.create({});
  const u = store.join(r.roomId, '小明');
  const evs = [];
  store.subscribe(r.roomId, (ev) => evs.push(ev));
  store.say(r.roomId, { memberId: u.memberId, text: '@ai 出事' });
  await tick(); await tick();
  assert.equal(store.get(r.roomId).status, 'idle');
  assert.ok(evs.some((e) => e.type === 'say' && e.message.kind === 'system' && /boom/.test(e.message.text)));
});

test('房間：進/離場事件帶完整成員名單（既有成員可即時重繪清單）', () => {
  const store = createRoomStore({ runAiTurn: async () => ({}) });
  const r = store.create({});
  const a = store.join(r.roomId, '小明');   // 先進場（成為訂閱者視角）
  const evs = []; store.subscribe(r.roomId, (ev) => evs.push(ev));
  store.join(r.roomId, '小華');             // 新用戶進場 → 既有成員應收到含兩人的名單
  const joinEv = evs.find((e) => e.type === 'member_join');
  assert.equal(joinEv.name, '小華');
  assert.deepEqual(joinEv.members, ['小明', '小華'], '進場事件帶完整名單');
  store.leave(r.roomId, a.memberId);
  const leaveEv = evs.find((e) => e.type === 'member_leave');
  assert.deepEqual(leaveEv.members, ['小華'], '離場事件帶更新後名單');
  assert.equal(store.leave(r.roomId, a.memberId), false); // 已離開
});

test('房間：命名 → view/list/snapshot 帶 name；過長截斷、空名回空字串', () => {
  const store = createRoomStore({ runAiTurn: async () => ({}) });
  const named = store.create({ name: '  首頁改版討論  ', workspace: 'w', pack: 'general' });
  assert.equal(named.name, '首頁改版討論', 'trim 後存名');
  assert.equal(store.view(named.roomId).name, '首頁改版討論');
  assert.equal(store.list().find((x) => x.roomId === named.roomId).name, '首頁改版討論');
  assert.equal(store.snapshot(named.roomId).name, '首頁改版討論');
  const long = store.create({ name: 'x'.repeat(80) });
  assert.equal(long.name.length, 60, '超過 60 字截斷');
  const anon = store.create({});
  assert.equal(anon.name, '', '未命名回空字串（前端回退顯示 workspace）');
});

test('房間：readonly 旗標存入 view/snapshot（預設 false）', () => {
  const store = createRoomStore({ runAiTurn: async () => ({}) });
  const ro = store.create({ readonly: true });
  assert.equal(store.view(ro.roomId).readonly, true);
  assert.equal(store.snapshot(ro.roomId).readonly, true);
  const rw = store.create({});
  assert.equal(store.view(rw.roomId).readonly, false, '預設非唯讀');
});

test('房間：list() 帶 inviteToken（供 operator 大廳複製邀請連結）', () => {
  const store = createRoomStore({ runAiTurn: async () => ({}) });
  const r = store.create({ workspace: 'w', pack: 'general' });
  const row = store.list().find((x) => x.roomId === r.roomId);
  assert.ok(row, '列表含此房');
  assert.equal(row.inviteToken, r.inviteToken, 'list 帶得出邀請碼');
});

test('房間：remove() 廣播 room_closed、斷訂閱、回傳 sessionId 供聯刪；再取回 null', async () => {
  const store = createRoomStore({ runAiTurn: async () => ({ sessionId: 'sess-x', text: 'r' }) });
  const r = store.create({});
  const u = store.join(r.roomId, '小明');
  // 先跑一輪讓房綁上 sessionId
  store.say(r.roomId, { memberId: u.memberId, text: '@ai 嗨' });
  await tick(); await tick(); await tick();
  assert.equal(store.get(r.roomId).sessionId, 'sess-x');
  const evs = []; const unsub = store.subscribe(r.roomId, (ev) => evs.push(ev));
  const res = store.remove(r.roomId);
  assert.equal(res.ok, true);
  assert.equal(res.sessionId, 'sess-x', '回傳 sessionId 供呼叫端聯刪 session');
  assert.ok(evs.some((e) => e.type === 'room_closed'), '廣播 room_closed');
  assert.equal(store.get(r.roomId), undefined, '房間已移除');
  assert.equal(store.view(r.roomId), null);
  assert.equal(store.remove(r.roomId), null, '再刪回 null');
  unsub(); // 冪等，不應拋錯
});

test('持久化：remove() 刪落地 json，重建 store 後房間不在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xk-rmroom-'));
  try {
    const s1 = createRoomStore({ runAiTurn: async () => ({}), persistDir: dir });
    const r = s1.create({ workspace: 'w' });
    s1.remove(r.roomId);
    const s2 = createRoomStore({ runAiTurn: async () => ({}), persistDir: dir });
    assert.equal(s2.view(r.roomId), null, '重建後已移除的房不再出現');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('持久化：房間與訊息落地，重建 store 後仍在（成員為即時態不存）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xk-rooms-'));
  try {
    const s1 = createRoomStore({ runAiTurn: async () => ({}), persistDir: dir });
    const r = s1.create({ name: '週會', workspace: 'w', pack: 'coding' });
    const u = s1.join(r.roomId, '小明');
    s1.say(r.roomId, { memberId: u.memberId, text: '哈囉' });
    const s2 = createRoomStore({ runAiTurn: async () => ({}), persistDir: dir });
    const v = s2.view(r.roomId);
    assert.ok(v, '重建後房間仍在');
    assert.equal(v.name, '週會', '名稱持久化');
    assert.equal(v.workspace, 'w');
    assert.equal(v.pack, 'coding');
    assert.equal(v.memberCount, 0, '成員不持久');
    assert.ok(s2.snapshot(r.roomId).messages.some((m) => m.text === '哈囉'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── HTTP 端點（黑箱：起真的 server，用 fetch 打）──────────────────
// ── 會議紀要（生成決策/待辦/摘要 + 匯出）──
test('minutesGoal：含決策/待辦/摘要三節 + gen_doc 產檔 + 對話 transcript', () => {
  const g = minutesGoal('[小明] 決定用 A');
  assert.match(g, /決策/); assert.match(g, /待辦/); assert.match(g, /摘要/);
  assert.match(g, /gen_doc/); assert.match(g, /會議紀要\.pdf/); assert.match(g, /小明/);
});

test('房間：生成會議紀要 — 帶「整段 transcript」呼叫 runMinutes + 狀態轉換 + 系統訊息', async () => {
  let gotTranscript = null;
  const store = createRoomStore({
    runAiTurn: async () => ({}),
    runMinutes: async ({ transcript, emit }) => { gotTranscript = transcript; emit({ type: 'text', delta: 'ok' }); return { text: '紀要完成' }; },
  });
  const r = store.create({});
  assert.equal(store.minutes(r.roomId).code, 400, '無對話 → 400');
  const u = store.join(r.roomId, '小明');
  store.say(r.roomId, { memberId: u.memberId, text: '我們決定用方案 A' });   // 閒聊（未 @ai，不會進 session，但要進紀要）
  const evs = []; store.subscribe(r.roomId, (ev) => evs.push(ev));
  assert.equal(store.minutes(r.roomId).ok, true);
  await tick(); await tick(); await tick();
  assert.match(gotTranscript, /小明/); assert.match(gotTranscript, /方案 A/); // 整段對話進紀要（含非召喚訊息）
  assert.ok(evs.some((e) => e.type === 'status' && e.status === 'thinking'));
  assert.ok(evs.some((e) => e.type === 'status' && e.status === 'idle'));
  assert.ok(evs.some((e) => e.type === 'say' && e.message.kind === 'system' && /會議紀要/.test(e.message.text)));
});

test('房間：紀要 AI 忙碌 → 409；未啟用（無 runMinutes）→ 501', () => {
  const busy = createRoomStore({ runAiTurn: async () => ({}), runMinutes: async () => ({}) });
  const r = busy.create({}); busy.get(r.roomId).status = 'thinking';
  assert.equal(busy.minutes(r.roomId).code, 409);
  const nogen = createRoomStore({ runAiTurn: async () => ({}) }); // 未注入 runMinutes
  const r2 = nogen.create({});
  assert.equal(nogen.minutes(r2.roomId).code, 501);
});

test('HTTP：/v1/rooms/:id/minutes 需成員 token → 202；無 → 401', async () => {
  await withServer(async ({ url, H }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: '{}' }).then((r) => r.json());
    const u = await fetch(url(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: H, body: JSON.stringify({ name: '小明' }) }).then((r) => r.json());
    const MH = { 'content-type': 'application/json', authorization: 'Bearer ' + u.memberToken };
    await fetch(url(`/v1/rooms/${room.roomId}/say`), { method: 'POST', headers: MH, body: JSON.stringify({ text: '決定用 A' }) });
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/minutes`), { method: 'POST' })).status, 401, '無 token → 401');
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/minutes`), { method: 'POST', headers: MH })).status, 202, '成員 token → 202');
  });
});

// ── 打斷 AI（中止進行中的回合）──
test('房間：stop 中止進行中的 AI 回合 → abort agent + ⏹ 訊息 + 回 idle，不推失敗/半截泡泡', async () => {
  let aborted = false;
  const store = createRoomStore({
    // 掛住不自行結束的回合；被 abort 時 reject('Aborted')（模擬 kernel abort 行為）
    runAiTurn: ({ onAgent }) => new Promise((_resolve, reject) => {
      onAgent({ abort: () => { aborted = true; reject(new Error('Aborted')); } });
    }),
  });
  const r = store.create({});
  const u = store.join(r.roomId, '小明');
  const evs = []; store.subscribe(r.roomId, (ev) => evs.push(ev));
  store.say(r.roomId, { memberId: u.memberId, text: '@ai 跑個大任務' }); // 觸發 runNow
  await tick();
  assert.equal(store.get(r.roomId).status, 'thinking');
  assert.equal(store.stop(r.roomId).ok, true);
  await tick(); await tick();
  assert.ok(aborted, 'agent 被 abort');
  assert.equal(store.get(r.roomId).status, 'idle', '中止後回 idle');
  assert.ok(evs.some((e) => e.type === 'say' && e.message.kind === 'system' && /中止/.test(e.message.text)), '廣播 ⏹ 中止訊息');
  assert.ok(!evs.some((e) => e.type === 'say' && e.message.kind === 'ai'), '不推半截 AI 泡泡');
  assert.ok(!evs.some((e) => e.type === 'say' && e.message.kind === 'system' && /失敗/.test(e.message.text)), '不推 AI 失敗訊息');
  // 中止後 idle，再 stop → 409
  assert.equal(store.stop(r.roomId).code, 409, '無進行中回合 → 409');
  assert.equal(store.stop('nope').code, 404);
});

test('HTTP：/v1/rooms/:id/stop 需成員 token；idle 時 409', async () => {
  await withServer(async ({ url, H }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: '{}' }).then((r) => r.json());
    const u = await fetch(url(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: H, body: JSON.stringify({ name: 'a' }) }).then((r) => r.json());
    const MH = { 'content-type': 'application/json', authorization: 'Bearer ' + u.memberToken };
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/stop`), { method: 'POST' })).status, 401, '無 token → 401');
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/stop`), { method: 'POST', headers: MH })).status, 409, '無進行中回合 → 409');
  });
});

async function withServer(fn) {
  const base = mkdtempSync(join(tmpdir(), 'xk-rsrv-'));
  const srv = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', baseDir: join(base, '.srv') });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const url = (p) => `http://localhost:${port}${p}`;
  const H = { 'content-type': 'application/json', authorization: 'Bearer t' };
  try { await fn({ url, H, base }); } finally { srv.close(); rmSync(base, { recursive: true, force: true }); }
}

test('joinUploadRel：組出 sub/name，name 取 basename 擋穿越；空/./.. 回 null', () => {
  assert.equal(joinUploadRel('', 'a.txt'), 'a.txt');
  assert.equal(joinUploadRel('docs', 'a.txt'), 'docs/a.txt');
  assert.equal(joinUploadRel('docs/', 'a.txt'), 'docs/a.txt');       // 去頭尾斜線
  assert.equal(joinUploadRel('', '../../etc/passwd'), 'passwd');     // name 內路徑段被剝掉
  assert.equal(joinUploadRel('', 'a/b.txt'), 'b.txt');              // name 只留末節點
  assert.equal(joinUploadRel('', ''), null);
  assert.equal(joinUploadRel('', '.'), null);
  assert.equal(joinUploadRel('', '..'), null);
});

test('lanIPs：回傳 IPv4 字串陣列（不含 loopback / link-local）', () => {
  const ips = lanIPs();
  assert.ok(Array.isArray(ips));
  for (const ip of ips) {
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!ip.startsWith('127.') && !ip.startsWith('169.254.'));
  }
});

// ── SSO auth seam（S1 骨架）：defaultAuth 忠實封裝現有邏輯 + 可注入 adapter，未注入即零行為變化 ──
test('defaultAuth：master token / 邀請碼 / 成員 token 判定與過去逐位元組一致', () => {
  const a = defaultAuth({ token: 't' });
  const reqH = (tok) => ({ headers: tok ? { authorization: 'Bearer ' + tok } : {}, url: '/x' });
  const reqQ = (tok) => ({ headers: {}, url: '/x?token=' + tok });
  // authed：header bearer 或 ?token=；未設 token → 全開
  assert.equal(a.authed(reqH('t')), true);
  assert.equal(a.authed(reqH('nope')), false);
  assert.equal(a.authed(reqQ('t')), true);
  assert.equal(defaultAuth({}).authed(reqH()), true);
  // roomAuth：master 過；成員 token；邀請碼（僅 join/read）；其他拒
  const room = { members: new Map([['m1', { token: 'mtok', name: '小明' }]]), inviteToken: 'inv' };
  assert.deepEqual(a.roomAuth(reqH('t'), room, 'read'), { ok: true, master: true });
  assert.equal(a.roomAuth(reqH('mtok'), room, 'member').memberId, 'm1');
  assert.equal(a.roomAuth(reqH('inv'), room, 'join').invite, true);
  assert.equal(a.roomAuth(reqH('inv'), room, 'member').ok, false); // 邀請碼不能當成員 token
  assert.equal(a.roomAuth(reqH('bad'), room, 'read').ok, false);
  // 預設無 SSO 身份 / 無 /auth 路由
  assert.equal(a.principal(reqH('t')), null);
  assert.equal(a.handle, null);
});

test('createServerApp：注入 auth adapter → handle 攔截 /auth/*，authed 由 adapter 決定', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-auth-'));
  let handled = 0;
  const auth = {
    authed: (req) => req.headers['x-admin'] === 'yes',
    roomAuth: () => ({ ok: false }),
    principal: () => null,
    handle: async (req, res) => {
      if (req.url.startsWith('/auth/login')) { handled++; res.writeHead(302, { location: '/idp' }); res.end(); return true; }
      return false;
    },
  };
  const srv = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', auth, baseDir: join(base, '.srv') });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    const r1 = await fetch(`http://localhost:${port}/auth/login`, { redirect: 'manual' });
    assert.equal(r1.status, 302, 'handle 攔截 /auth/login → 302');
    assert.equal(handled, 1);
    const r2 = await fetch(`http://localhost:${port}/v1/models`);
    assert.equal(r2.status, 401, '無 x-admin → adapter.authed 擋下');
    const r3 = await fetch(`http://localhost:${port}/v1/models`, { headers: { 'x-admin': 'yes' } });
    assert.equal(r3.status, 200, '帶 x-admin → adapter.authed 放行');
  } finally { srv.close(); rmSync(base, { recursive: true, force: true }); }
});

// ── SSO 角色名冊（S2）：roleOf 五級判定、釘死 admin 保護、持久化、/v1/admins CRUD ──
test('createRoleStore：roleOf 五級判定（釘死 admin / 名冊 / 網域 / 封閉拒絕 / 未驗證）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xk-roles-'));
  try {
    const s = createRoleStore({ dir, adminEmails: ['boss@corp.com'], allowedDomain: 'corp.com' });
    const p = (email, extra = {}) => ({ email, ...extra });
    assert.equal(s.roleOf(p('boss@corp.com')), 'admin');                        // 釘死
    assert.equal(s.roleOf(p('BOSS@Corp.com')), 'admin');                        // 大小寫不敏感
    assert.equal(s.roleOf(p('someone@corp.com')), 'member');                    // 網域放行
    assert.equal(s.roleOf(p('x@other.com')), null);                             // 封閉名冊拒絕
    assert.equal(s.roleOf(p('x@corp.com', { email_verified: false })), null);   // 未驗證拒絕
    assert.equal(s.roleOf({}), null);                                           // 無 email
    s.set('guest@corp.com', 'readonly');
    assert.equal(s.roleOf(p('guest@corp.com')), 'readonly');                    // 名冊優先於網域
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createRoleStore：釘死 admin 不可改/刪；一般項增刪並持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xk-roles-'));
  try {
    const s = createRoleStore({ dir, adminEmails: ['boss@corp.com'] });
    assert.equal(s.set('boss@corp.com', 'member').ok, false);   // 釘死不可改
    assert.equal(s.remove('boss@corp.com').ok, false);          // 釘死不可刪
    assert.equal(s.set('a@x.com', 'admin').ok, true);
    assert.equal(s.set('a@x.com', 'bogus').ok, false);          // 非法 role
    const s2 = createRoleStore({ dir, adminEmails: ['boss@corp.com'] }); // 重載 → 持久化保留
    assert.equal(s2.roleOf({ email: 'a@x.com' }), 'admin');
    assert.ok(s2.list().some((x) => x.email === 'boss@corp.com' && x.pinned));
    assert.equal(s2.remove('a@x.com').ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP：非 SSO 模式 /v1/me → { ssoActive:false }（前端據此不顯示帳號 chip）', async () => {
  await withServer(async ({ url }) => {
    assert.deepEqual(await fetch(url('/v1/me')).then((r) => r.json()), { ssoActive: false });
  });
});

test('HTTP：/v1/admins CRUD 需 operator；釘死 admin 受保護', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-admins-'));
  const srv = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', adminEmails: ['boss@corp.com'], baseDir: join(base, '.srv') });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const U = (p) => `http://localhost:${port}${p}`;
  const H = { 'content-type': 'application/json', authorization: 'Bearer t' };
  try {
    assert.equal((await fetch(U('/v1/admins'))).status, 401);                    // 無 token → 401
    const list0 = await fetch(U('/v1/admins'), { headers: H }).then((r) => r.json());
    assert.ok(list0.roles.some((x) => x.email === 'boss@corp.com' && x.pinned)); // 釘死 admin 列出
    const add = await fetch(U('/v1/admins'), { method: 'POST', headers: H, body: JSON.stringify({ email: 'Alice@corp.com', role: 'member' }) });
    assert.equal(add.status, 200);
    const list1 = await fetch(U('/v1/admins'), { headers: H }).then((r) => r.json());
    assert.ok(list1.roles.some((x) => x.email === 'alice@corp.com' && x.role === 'member')); // 正規化小寫
    assert.equal((await fetch(U('/v1/admins/alice@corp.com'), { method: 'DELETE', headers: H })).status, 200);
    assert.equal((await fetch(U('/v1/admins/boss@corp.com'), { method: 'DELETE', headers: H })).status, 400); // 釘死不可刪
    assert.equal((await fetch(U('/v1/admins'), { method: 'POST', headers: H, body: JSON.stringify({ email: 'x@x.com', role: 'root' }) })).status, 400); // 非法 role
  } finally { srv.close(); rmSync(base, { recursive: true, force: true }); }
});

test('HTTP：/room 主控台注入 master token；訪客頁（帶 ?room=）不注入', async () => {
  await withServer(async ({ url }) => {
    const host = await fetch(url('/room')).then((r) => r.text());
    assert.match(host, /專案會議室/);
    assert.doesNotMatch(host, /__SERVER_TOKEN__/); // 已替換
    assert.match(host, /token:\s*"t"/);            // 主控台拿到 master token（可建房）
    const guest = await fetch(url('/room?room=abc&invite=xyz')).then((r) => r.text());
    assert.match(guest, /token:\s*""/);            // 訪客頁不含 master token（只靠 URL 邀請碼）
  });
});

test('HTTP：/room 注入 publicOrigin（供邀請連結對外網址）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-po-'));
  const srv = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', baseDir: join(base, '.srv'), publicOrigin: 'http://192.168.1.5:8787' });
  await new Promise((r) => srv.listen(0, r));
  try {
    const html = await fetch(`http://localhost:${srv.address().port}/room`).then((r) => r.text());
    assert.match(html, /origin:\s*"http:\/\/192\.168\.1\.5:8787"/);
    assert.doesNotMatch(html, /__PUBLIC_ORIGIN__/);
  } finally { srv.close(); rmSync(base, { recursive: true, force: true }); }
});

test('HTTP：邀請碼 → 加入換成員 token 全流程；亂碼邀請碼被擋', async () => {
  await withServer(async ({ url, H }) => {
    // 建房（master）→ 拿 inviteToken
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ pack: 'general' }) }).then((r) => r.json());
    assert.ok(room.inviteToken, '建房回應含邀請碼');
    const inv = { 'content-type': 'application/json', authorization: 'Bearer ' + room.inviteToken };
    // 錯的邀請碼 → 401
    const bad = await fetch(url(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer WRONG' }, body: JSON.stringify({ name: 'x' }) });
    assert.equal(bad.status, 401);
    // 對的邀請碼 → 加入，換得成員 token
    const j = await fetch(url(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: inv, body: JSON.stringify({ name: '小華' }) }).then((r) => r.json());
    assert.ok(j.memberToken, '加入回應含成員 token');
    const mem = { 'content-type': 'application/json', authorization: 'Bearer ' + j.memberToken };
    // 只有邀請碼不能發言（need=member）→ 401
    const inviteSay = await fetch(url(`/v1/rooms/${room.roomId}/say`), { method: 'POST', headers: inv, body: JSON.stringify({ text: 'hi' }) });
    assert.equal(inviteSay.status, 401);
    // 成員 token 可發言，且身分由 token 決定（不吃 body 冒名）
    const say = await fetch(url(`/v1/rooms/${room.roomId}/say`), { method: 'POST', headers: mem, body: JSON.stringify({ text: '大家好', memberId: 'spoofed' }) }).then((r) => r.json());
    assert.equal(say.ok, true);
    const snap = await fetch(url(`/v1/rooms/${room.roomId}`), { headers: mem }).then((r) => r.json());
    assert.ok(snap.messages.some((m) => m.name === '小華' && m.text === '大家好'), '發言者為 token 綁定的小華，非冒名者');
    // 無任何憑證 → 401
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}`))).status, 401);
  });
});

test('HTTP：換發邀請碼（master）→ 舊碼失效', async () => {
  await withServer(async ({ url, H }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({}) }).then((r) => r.json());
    const oldInv = room.inviteToken;
    const rot = await fetch(url(`/v1/rooms/${room.roomId}/invite`), { method: 'POST', headers: H }).then((r) => r.json());
    assert.ok(rot.inviteToken && rot.inviteToken !== oldInv, '換發新碼');
    // 舊碼加入 → 401
    const withOld = await fetch(url(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + oldInv }, body: JSON.stringify({ name: 'x' }) });
    assert.equal(withOld.status, 401);
    // 換發需 master
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/invite`), { method: 'POST' })).status, 401);
  });
});

test('HTTP：建房 → 加入 → 發言 → 快照含訊息；未加入發言被擋', async () => {
  await withServer(async ({ url, H }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ workspace: 'w', pack: 'general' }) }).then((r) => r.json());
    assert.ok(room.roomId);
    // 未加入 → 403
    const bad = await fetch(url(`/v1/rooms/${room.roomId}/say`), { method: 'POST', headers: H, body: JSON.stringify({ memberId: 'x', text: 'hi' }) });
    assert.equal(bad.status, 403);
    // 加入
    const j = await fetch(url(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: H, body: JSON.stringify({ name: '小明' }) }).then((r) => r.json());
    assert.ok(j.memberId);
    // 發言（不 @ai → 不觸發，避免測試打真模型）
    const say = await fetch(url(`/v1/rooms/${room.roomId}/say`), { method: 'POST', headers: H, body: JSON.stringify({ memberId: j.memberId, text: '大家好' }) }).then((r) => r.json());
    assert.equal(say.ok, true);
    assert.equal(say.triggered, false);
    // 快照含該訊息
    const snap = await fetch(url(`/v1/rooms/${room.roomId}`), { headers: H }).then((r) => r.json());
    assert.equal(snap.workspace, 'w');
    assert.ok(snap.messages.some((m) => m.text === '大家好' && m.name === '小明'));
    // 列房
    const list = await fetch(url('/v1/rooms'), { headers: H }).then((r) => r.json());
    assert.ok(list.rooms.some((x) => x.roomId === room.roomId));
  });
});

test('HTTP：房間檔案目录（憑成員 token 列檔/取檔，限本房 workspace）', async () => {
  await withServer(async ({ url, H, base }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ workspace: 'proj' }) }).then((r) => r.json());
    // 在該房 workspace 放一個檔（模擬 AI 產出）
    const wsDir = join(base, '.srv', 'ws', 'proj');
    mkdirSync(wsDir, { recursive: true }); writeFileSync(join(wsDir, 'report.md'), '# 會議紀要\n決議：改版');
    const inv = { authorization: 'Bearer ' + room.inviteToken };
    // 列檔（邀請碼可讀）
    const files = await fetch(url(`/v1/rooms/${room.roomId}/files`), { headers: inv }).then((r) => r.json());
    assert.ok(files.files.some((f) => f.name === 'report.md'));
    // 取檔內容
    const txt = await fetch(url(`/v1/rooms/${room.roomId}/file?path=report.md&token=${room.inviteToken}`)).then((r) => r.text());
    assert.match(txt, /會議紀要/);
    // 防穿越
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/file?path=../../secret&token=${room.inviteToken}`))).status, 400);
    // 無憑證 → 401
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/files`))).status, 401);
  });
});

test('HTTP：DELETE 關房（master）→ 房間消失、落地 json 刪除；非 master 被擋；未知房 404', async () => {
  await withServer(async ({ url, H, base }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ pack: 'general' }) }).then((r) => r.json());
    assert.ok(existsSync(join(base, '.srv', 'rooms', room.roomId + '.json')), '建房已落地');
    // 非 master → 401
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}`), { method: 'DELETE' })).status, 401);
    // master → 200
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}`), { method: 'DELETE', headers: H })).status, 200);
    // 已消失（GET 404、再 DELETE 也 404）
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}`), { headers: H })).status, 404);
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}`), { method: 'DELETE', headers: H })).status, 404);
    // 落地 json 也刪了
    assert.ok(!existsSync(join(base, '.srv', 'rooms', room.roomId + '.json')), '房間 json 已刪');
  });
});

test('HTTP：列房帶 inviteToken（供大廳複製邀請連結）', async () => {
  await withServer(async ({ url, H }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ pack: 'general' }) }).then((r) => r.json());
    const list = await fetch(url('/v1/rooms'), { headers: H }).then((r) => r.json());
    const row = list.rooms.find((x) => x.roomId === room.roomId);
    assert.equal(row.inviteToken, room.inviteToken, '列房帶得出邀請碼');
  });
});

test('HTTP：建資料夾 + 上傳到指定資料夾（成員可寫；邀請碼只讀被擋；防穿越/空檔）', async () => {
  await withServer(async ({ url, H, base }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ workspace: 'proj' }) }).then((r) => r.json());
    const inv = { 'content-type': 'application/json', authorization: 'Bearer ' + room.inviteToken };
    // 只有邀請碼（唯讀）→ 建夾被擋 401
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/mkdir`), { method: 'POST', headers: inv, body: JSON.stringify({ name: '報告' }) })).status, 401);
    // 成員（master 亦可）→ 在根建 docs
    const mk = await fetch(url(`/v1/rooms/${room.roomId}/mkdir`), { method: 'POST', headers: H, body: JSON.stringify({ sub: '', name: 'docs' }) }).then((r) => r.json());
    assert.equal(mk.ok, true); assert.equal(mk.sub, 'docs');
    assert.ok(existsSync(join(base, '.srv', 'ws', 'proj', 'docs')), '實際建出資料夾');
    // 非法夾名 → 400
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/mkdir`), { method: 'POST', headers: H, body: JSON.stringify({ name: '..' }) })).status, 400);

    // 上傳到 docs 子資料夾（sub=docs）→ 落在該處
    const up = await fetch(url(`/v1/rooms/${room.roomId}/upload?sub=docs&name=note.txt`), { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'text/plain' }, body: '會議要點' }).then((r) => r.json());
    assert.equal(up.ok, true); assert.equal(up.sub, 'docs/note.txt'); assert.ok(up.size > 0);
    assert.ok(existsSync(join(base, '.srv', 'ws', 'proj', 'docs', 'note.txt')), '檔案落在指定資料夾');
    // 取回內容
    const back = await fetch(url(`/v1/rooms/${room.roomId}/file?path=docs/note.txt&token=t`)).then((r) => r.text());
    assert.match(back, /會議要點/);
    // 上傳到根（不同資料夾）→ 落在根
    await fetch(url(`/v1/rooms/${room.roomId}/upload?sub=&name=root.txt`), { method: 'POST', headers: { authorization: 'Bearer t' }, body: 'x' }).then((r) => r.json());
    assert.ok(existsSync(join(base, '.srv', 'ws', 'proj', 'root.txt')), '可上傳到不同資料夾');
    // 只有邀請碼（唯讀）→ 上傳被擋 401
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/upload?name=x.txt`), { method: 'POST', headers: { authorization: 'Bearer ' + room.inviteToken }, body: 'x' })).status, 401);
    // 防穿越：sub 帶 .. → 400
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/upload?sub=../../&name=hack`), { method: 'POST', headers: { authorization: 'Bearer t' }, body: 'x' })).status, 400);
    // 空檔 → 400
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/upload?name=empty.txt`), { method: 'POST', headers: { authorization: 'Bearer t' }, body: '' })).status, 400);
  });
});

test('HTTP：唯讀會議 → 成員（訪客）不能上傳/建夾（403），主持人（master）仍可', async () => {
  await withServer(async ({ url, H, base }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ workspace: 'proj', readonly: true }) }).then((r) => r.json());
    assert.equal(room.readonly, true, '建房回應帶 readonly');
    // 訪客憑邀請碼加入 → 成員 token
    const inv = { 'content-type': 'application/json', authorization: 'Bearer ' + room.inviteToken };
    const j = await fetch(url(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: inv, body: JSON.stringify({ name: '訪客' }) }).then((r) => r.json());
    const mem = { 'content-type': 'application/json', authorization: 'Bearer ' + j.memberToken };
    // 成員（非主持人）上傳/建夾 → 403
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/upload?name=x.txt`), { method: 'POST', headers: { authorization: 'Bearer ' + j.memberToken }, body: 'x' })).status, 403);
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/mkdir`), { method: 'POST', headers: mem, body: JSON.stringify({ name: 'docs' }) })).status, 403);
    // 主持人（master）仍可寫
    assert.equal((await fetch(url(`/v1/rooms/${room.roomId}/mkdir`), { method: 'POST', headers: H, body: JSON.stringify({ name: 'docs' }) })).status, 200);
    assert.ok(existsSync(join(base, '.srv', 'ws', 'proj', 'docs')), '主持人建出資料夾');
  });
});

test('HTTP：上傳超過上限 → 413', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-big-'));
  const prev = process.env.XITTO_MAX_UPLOAD;
  process.env.XITTO_MAX_UPLOAD = '8'; // 8 bytes 上限
  const srv = createServerApp({ model: { id: 'm', provider: 'p' }, getApiKey: () => 'k', token: 't', baseDir: join(base, '.srv') });
  await new Promise((r) => srv.listen(0, r));
  try {
    const port = srv.address().port, U = (p) => `http://localhost:${port}${p}`;
    const H = { 'content-type': 'application/json', authorization: 'Bearer t' };
    const room = await fetch(U('/v1/rooms'), { method: 'POST', headers: H, body: '{}' }).then((r) => r.json());
    const big = await fetch(U(`/v1/rooms/${room.roomId}/upload?name=big.bin`), { method: 'POST', headers: { authorization: 'Bearer t' }, body: 'x'.repeat(64) });
    assert.equal(big.status, 413);
  } finally {
    srv.close(); rmSync(base, { recursive: true, force: true });
    if (prev === undefined) delete process.env.XITTO_MAX_UPLOAD; else process.env.XITTO_MAX_UPLOAD = prev;
  }
});

// 讀 SSE 一小段（收集 say 事件的 message.id），到齊 want 個或逾時就中止。
async function readSaySSE(url, headers, want, ms = 400) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), ms);
  const ids = [];
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (data) { try { const ev = JSON.parse(data.slice(6)); if (ev.type === 'say') ids.push(ev.message.id); } catch { /* 略 */ } }
      }
      if (ids.length >= want) { ac.abort(); break; }
    }
  } catch { /* abort 正常 */ } finally { clearTimeout(to); }
  return ids;
}

test('HTTP：SSE 重連帶 Last-Event-ID → 只補發其後訊息（不重放已收到的）', async () => {
  await withServer(async ({ url, H }) => {
    const room = await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: '{}' }).then((r) => r.json());
    const u = await fetch(url(`/v1/rooms/${room.roomId}/join`), { method: 'POST', headers: H, body: JSON.stringify({ name: '小明' }) }).then((r) => r.json());
    const MH = { 'content-type': 'application/json', authorization: 'Bearer ' + u.memberToken };
    await fetch(url(`/v1/rooms/${room.roomId}/say`), { method: 'POST', headers: MH, body: JSON.stringify({ text: '第一則' }) });
    await fetch(url(`/v1/rooms/${room.roomId}/say`), { method: 'POST', headers: MH, body: JSON.stringify({ text: '第二則' }) });
    const evUrl = url(`/v1/rooms/${room.roomId}/events?token=t`);
    const first = await readSaySSE(evUrl, {}, 2);
    assert.equal(first.length, 2, '首次連線補發全部 2 則');
    // 帶 Last-Event-ID = 第一則 id → 應只補發第二則
    const again = await readSaySSE(evUrl, { 'last-event-id': first[0] }, 1);
    assert.deepEqual(again, [first[1]], '只補發其後的第二則，不重放第一則');
  });
});

test('HTTP：未知 room → 404；建房未知 pack → 400；需認證', async () => {
  await withServer(async ({ url, H }) => {
    assert.equal((await fetch(url('/v1/rooms/nope'), { headers: H })).status, 404);
    assert.equal((await fetch(url('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ pack: 'zzz' }) })).status, 400);
    assert.equal((await fetch(url('/v1/rooms'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  });
});

// 多 provider / 運行時選 model：/v1/models 列清單、建房帶 model、對話中切換、未知 model 擋 400。
async function withModelServer(fn) {
  const base = mkdtempSync(join(tmpdir(), 'xk-mdl-'));
  const models = [{ id: 'm', name: 'M', provider: 'p' }, { id: 'big', name: 'Big', provider: 'q' }];
  const resolveModel = (id) => { const m = models.find((x) => x.id === id); return m ? { id: m.id, name: m.name, provider: m.provider, api: 'openai-completions', baseUrl: 'u' } : null; };
  const srv = createServerApp({ model: { id: 'm', name: 'M', provider: 'p' }, getApiKey: () => 'k', resolveModel, models, token: 't', baseDir: join(base, '.srv') });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port, U = (p) => `http://localhost:${port}${p}`;
  const H = { 'content-type': 'application/json', authorization: 'Bearer t' };
  try { await fn({ U, H }); } finally { srv.close(); rmSync(base, { recursive: true, force: true }); }
}

test('HTTP：/settings 設定頁（需 master）；/v1/setup 合併寫入既有 providers.json', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xk-set-'));
  const cfgPath = join(base, 'providers.json');
  writeFileSync(cfgPath, JSON.stringify({ defaultModel: 'm', providers: { p: { api: 'openai-completions', baseUrl: 'u', apiKey: 'k', models: [{ id: 'm', name: 'M' }] } } }));
  const srv = createServerApp({ model: { id: 'm', name: 'M', provider: 'p' }, getApiKey: () => 'k', token: 't', baseDir: join(base, '.srv'), configPath: cfgPath });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port, U = (p) => `http://localhost:${port}${p}`;
  const H = { 'content-type': 'application/json', authorization: 'Bearer t' };
  try {
    assert.equal((await fetch(U('/settings'))).status, 401, '無 token → 401');
    assert.match(await fetch(U('/settings'), { headers: H }).then((r) => r.text()), /模型設定/);
    const r = await fetch(U('/v1/setup'), { method: 'POST', headers: H, body: JSON.stringify({ provider: 'q', baseUrl: 'u2', apiKey: 'k2', modelId: 'big' }) }).then((r) => r.json());
    assert.equal(r.ok, true);
    const saved = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(saved.defaultModel, 'm', '合併不改預設');
    assert.ok(saved.providers.p && saved.providers.q, '既有 p 保留、新 q 加入');
  } finally { srv.close(); rmSync(base, { recursive: true, force: true }); }
});

test('HTTP：/v1/models 列出跨 provider 清單 + 標記 default（需 master）', async () => {
  await withModelServer(async ({ U, H }) => {
    assert.equal((await fetch(U('/v1/models'))).status, 401, '無 token → 401');
    const j = await fetch(U('/v1/models'), { headers: H }).then((r) => r.json());
    assert.equal(j.default, 'm');
    assert.deepEqual(j.models.map((x) => x.id).sort(), ['big', 'm']);
  });
});

test('HTTP：建房可指定 model；未知 model → 400；POST /model 切換並回落預設', async () => {
  await withModelServer(async ({ U, H }) => {
    // 建房帶未知 model → 400
    assert.equal((await fetch(U('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ model: 'zzz' }) })).status, 400);
    // 建房帶合法 model → view.model 記住
    const room = await fetch(U('/v1/rooms'), { method: 'POST', headers: H, body: JSON.stringify({ model: 'big' }) }).then((r) => r.json());
    assert.equal(room.model, 'big');
    // 切回預設（傳 default id → 記為 null）
    const back = await fetch(U(`/v1/rooms/${room.roomId}/model`), { method: 'POST', headers: H, body: JSON.stringify({ model: 'm' }) }).then((r) => r.json());
    assert.equal(back.model, null, '傳預設 id → 回落 null（用伺服器預設）');
    // 切到未知 model → 400
    assert.equal((await fetch(U(`/v1/rooms/${room.roomId}/model`), { method: 'POST', headers: H, body: JSON.stringify({ model: 'zzz' }) })).status, 400);
  });
});
