// 細粒度權限：bash 命令「簽章」與 allow.json 的解析/序列化（向後相容舊格式）。
// 對標 Claude Code 的 Bash(npm test) 規則 —— 放行某類命令而非整個 bash 工具。

// 帶子命令的工具：簽章取前兩詞（npm test、git status、docker compose），其餘取首詞（ls、cat）。
// 這讓「允許 npm test」只放行 npm test 系列，npm install / npm run build 仍需確認。
const SUBCMD = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'bun', 'deno',
  'git', 'cargo', 'go', 'docker', 'make', 'kubectl',
  'python', 'python3', 'pip', 'pip3', 'node', 'dotnet', 'mvn', 'gradle',
]);

export function commandSignature(cmd) {
  if (typeof cmd !== 'string') return '';
  const t = cmd.trim().split(/\s+/).filter(Boolean);
  if (!t.length) return '';
  // env 前綴（VAR=val cmd）跳過
  let i = 0;
  while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
  const head = t.slice(i);
  if (!head.length) return '';
  if (head.length >= 2 && SUBCMD.has(head[0])) return `${head[0]} ${head[1]}`;
  return head[0];
}

// 解析 allow.json：向後相容。
//   舊格式：工具名字串陣列 ["bash","write"]
//   新格式：{ tools: ["write"], bash: ["npm test","git status"] }
export function parseAllowFile(raw) {
  if (Array.isArray(raw)) return { tools: raw.filter((x) => typeof x === 'string'), bash: [] };
  if (raw && typeof raw === 'object') {
    return {
      tools: Array.isArray(raw.tools) ? raw.tools.filter((x) => typeof x === 'string') : [],
      bash: Array.isArray(raw.bash) ? raw.bash.filter((x) => typeof x === 'string') : [],
    };
  }
  return { tools: [], bash: [] };
}

export function serializeAllow(tools, bash) {
  return JSON.stringify({ tools: [...tools], bash: [...bash] }, null, 2);
}
