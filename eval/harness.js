// xitto-kernel ↔ SWE-bench 風格評估 harness。
// 流程對齊 SWE-bench：建 repo(base commit) → 確認修復前測試失敗(FAIL_TO_PASS) → agent 只看 problem
// 產 patch → 跑隱藏測試判定 resolved。記錄 patch / 回合數 / token 用量。
// 註：完整 SWE-bench 用 Docker 每題環境；此 harness 用自足任務（純 node、零外部依賴）驗證流程。
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createKernel } from '../src/kernel/index.js';
import { createCodingPack } from '../src/packs/coding/index.js';

const sh = (cmd, cwd) => {
  try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` || e.message }; }
};

/**
 * 跑一題。task: { id, setup:{path:content}, problem, verify(測試命令，須 fail→pass), passToPass?(改完仍須過) }
 * @returns {Promise<{ id, resolved, preFails, rounds, done, usage, patch }>}
 */
export async function runTask(task, { model, getApiKey, maxRounds = 6, sandbox = false }) {
  const dir = mkdtempSync(join(tmpdir(), `swe-${task.id}-`));
  try {
    // 1) 建 repo（base commit）
    for (const [f, content] of Object.entries(task.setup)) {
      const p = join(dir, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
    }
    sh('git init -q && git config user.email e@e.co && git config user.name e && git add -A && git commit -q -m base', dir);

    // 2) sanity：修復前隱藏測試應失敗（= SWE-bench 的 FAIL_TO_PASS 起點）
    const preFails = !sh(task.verify, dir).ok;

    // 3) 跑 agent —— 只給 problem，不給測試命令（agent 看不到隱藏測試）
    const usage = { input: 0, output: 0, cost: 0 };
    const kernel = createKernel(createCodingPack({ cwd: dir }), {
      cwd: dir, model, getApiKey,
      sandbox: { enabled: sandbox }, getSandbox: () => sandbox,
      confirm: async () => 'yes', // headless 自動核准
    });
    const onEvent = (e) => {
      if (e.type === 'message_end' && e.message?.usage) {
        usage.input += e.message.usage.input || 0;
        usage.output += e.message.usage.output || 0;
        usage.cost += e.message.usage.cost?.total || 0;
      }
    };
    const res = await kernel.runGoal(task.problem, { maxRounds, onEvent });

    // 4) 取 patch + 跑隱藏測試判定
    const patch = sh('git diff', dir).out;
    const passToPass = task.passToPass ? sh(task.passToPass, dir).ok : true;
    const resolved = sh(task.verify, dir).ok && passToPass;

    return { id: task.id, resolved, preFails, rounds: res.rounds, done: res.done, usage, patch };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
