// 真實 LLM 端到端：用 coding pack + MiniMax 跑一輪，讓模型實際呼叫工具完成任務。
// 跑法：node examples/live.js  （需 ~/.xitto-code/providers.json 內有可用 key）
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';
import { loadModel } from '../src/app/providers.js';

const { model, getApiKey } = loadModel();
const dir = mkdtempSync(join(tmpdir(), 'live-'));

const k = createKernel(createCodingPack({ cwd: dir }), { cwd: dir, model, getApiKey });

console.log(`\n=== live：coding pack + ${model.id} ===`);
console.log(`工作目錄：${dir}\n`);

const task = '在工作目錄建立一個 hello.txt，內容是「你好，xitto-kernel」。建好後用 ls 確認。';
console.log(`▌ ${task}\n`);

const { text } = await k.runTurn(task, {
  onEvent: (e) => {
    if (e.type === 'tool_execution_start') process.stdout.write(`  ⚙ ${e.toolName}(${JSON.stringify(e.args)})\n`);
    if (e.type === 'tool_execution_end') process.stdout.write(`  ⎿ ${e.isError ? '✗' : '✓'} ${e.toolName}\n`);
  },
});

console.log(`\n● ${text}\n`);
const f = join(dir, 'hello.txt');
console.log(existsSync(f) ? `✅ hello.txt 已建立：${JSON.stringify(readFileSync(f, 'utf8'))}` : '✗ 檔案未建立');
rmSync(dir, { recursive: true, force: true });
