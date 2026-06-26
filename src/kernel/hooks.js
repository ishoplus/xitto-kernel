// PreToolUse / PostToolUse hooks — kernel 內建，由 .xitto-kernel/<pack>/settings.json 驅動。
// Pre：matched 工具執行前跑命令，非零退出→擋下。Post：matched 工具成功後跑命令，失敗→回灌讓 agent 修正。
// 對標 xitto-code hooks.js。settings.json: { "hooks": { "PreToolUse": [{matcher, command, timeout}], "PostToolUse": [...] } }
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const asRules = (x) => (Array.isArray(x) ? x.filter((r) => r && typeof r.command === 'string') : []);

export function loadHooks(settingsPath) {
  if (!existsSync(settingsPath)) return { PreToolUse: [], PostToolUse: [] };
  try {
    const h = (JSON.parse(readFileSync(settingsPath, 'utf8')).hooks) || {};
    return { PreToolUse: asRules(h.PreToolUse), PostToolUse: asRules(h.PostToolUse) };
  } catch { return { PreToolUse: [], PostToolUse: [] }; }
}

const matches = (rule, name) => { try { return new RegExp(rule.matcher || '.*').test(name); } catch { return false; } };

function runRule(rule, cwd) {
  try {
    const out = execSync(rule.command, { cwd, encoding: 'utf8', timeout: rule.timeout || 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: out || '' };
  } catch (e) {
    return { ok: false, output: (`${e.stdout || ''}${e.stderr || ''}` || e.message || '').toString() };
  }
}

// PreToolUse：任一 matched hook 非零退出 → 回 block（理由含輸出）
export function runPreToolHooks(hooks, name, cwd) {
  for (const rule of hooks.PreToolUse) {
    if (!matches(rule, name)) continue;
    const r = runRule(rule, cwd);
    if (!r.ok) return { block: true, reason: `PreToolUse hook 阻止 ${name}：\n${r.output.slice(0, 1000)}` };
  }
  return undefined;
}

// PostToolUse：回失敗清單 [{command, output}]（供呼叫端回灌給 agent）
export function runPostToolHooks(hooks, name, cwd) {
  const fails = [];
  for (const rule of hooks.PostToolUse) {
    if (!matches(rule, name)) continue;
    const r = runRule(rule, cwd);
    if (!r.ok) fails.push({ command: rule.command, output: r.output });
  }
  return fails;
}
