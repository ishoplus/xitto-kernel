// 串流診斷：對設定的模型發「一次」真實串流呼叫，印出 kernel 收到的事件型別與 text_delta 逐字情況。
// 用途：確認「輸出中沒顯示」是不是因為真實 provider 沒有逐字送 text_delta。
// 跑法：node scripts/diag-stream.mjs
import { loadModel } from '../src/app/providers.js';
import { createKernel } from '../src/kernel/index.js';
import { createGeneralPack } from '../src/packs/general/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { model, getApiKey, resolveModel } = loadModel();
console.log(`模型：${model.id} · api=${model.api} · baseUrl=${model.baseUrl || '?'}`);

const cwd = mkdtempSync(join(tmpdir(), 'diag-'));
const kernel = createKernel(createGeneralPack({ cwd }), { cwd, model, getApiKey, resolveModel });

const counts = {};
let deltaChars = 0, firstDeltaAt = null, startAt = Date.now();
const t = (ms) => `${ms}ms`;

await kernel.runTurn('用一句話介紹你自己，然後數 1 到 20，每個數字一行。', {
  onEvent: (e) => {
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (e.type === 'message_update') {
      const a = e.assistantMessageEvent;
      const sub = 'message_update:' + (a?.type || '?');
      counts[sub] = (counts[sub] || 0) + 1;
      if (a?.type === 'text_delta' && a.delta) {
        if (firstDeltaAt == null) firstDeltaAt = Date.now() - startAt;
        deltaChars += a.delta.length;
      }
    }
  },
});

console.log('\n=== 事件統計 ===');
for (const [k, v] of Object.entries(counts).sort()) console.log(`${String(v).padStart(4)}  ${k}`);
console.log('\n=== 逐字串流判定 ===');
const td = counts['message_update:text_delta'] || 0;
console.log(`text_delta 次數：${td}`);
console.log(`text_delta 累計字數：${deltaChars}`);
console.log(`第一個 text_delta 到達：${firstDeltaAt == null ? '(從未到達)' : t(firstDeltaAt)}`);
console.log(`\n判定：${td >= 3 ? '✅ 有逐字串流（輸出中應顯示；問題在 UI 層，已修 flicker）' : '❌ 幾乎沒有 text_delta（provider/串流層問題——文字整塊到達，這才是「沒有輸出中」的根因）'}`);
process.exit(0);
