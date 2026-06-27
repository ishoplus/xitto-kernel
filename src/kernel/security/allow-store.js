// 漸進式放權的「已信任」儲存：記住使用者批准過的工具/命令簽章,跨 session 累積。
// 兩種實作：memory（headless/測試,不落地）與 file（落地到 .xitto-kernel/<pack>/allow.json）。
// 格式與細粒度簽章見 allow.js（parseAllowFile / serializeAllow / commandSignature）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseAllowFile, serializeAllow } from './allow.js';

function makeStore(seed, flush, path) {
  const tools = new Set(seed.tools || []);
  const bash = new Set(seed.bash || []);
  const save = () => flush?.(tools, bash);
  return {
    path: path || null,
    hasTool: (n) => tools.has(n),
    hasSig: (s) => bash.has(s),
    addTool: (n) => { if (!tools.has(n)) { tools.add(n); save(); } },
    addSig: (s) => { if (s && !bash.has(s)) { bash.add(s); save(); } },
    // forget：可傳工具名或 bash 簽章；回傳是否真的移除了
    remove: (entry) => { const a = tools.delete(entry); const b = bash.delete(entry); if (a || b) save(); return a || b; },
    clear: () => { const had = tools.size + bash.size > 0; tools.clear(); bash.clear(); if (had) save(); return had; },
    list: () => ({ tools: [...tools], bash: [...bash] }),
    size: () => tools.size + bash.size,
  };
}

// 記憶體版：session 內有效,重啟即忘（headless / 測試 / 明確關閉持久化時）。
export function memoryAllowStore(seed = {}) {
  return makeStore(seed, null, null);
}

// 檔案版：啟動時載入既有信任,每次變更立即落地。重啟後信任仍在 → 漸進累積。
export function fileAllowStore(path) {
  let parsed = { tools: [], bash: [] };
  try { if (existsSync(path)) parsed = parseAllowFile(JSON.parse(readFileSync(path, 'utf8'))); } catch { /* 壞檔忽略,當空 */ }
  const flush = (tools, bash) => {
    try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, serializeAllow(tools, bash) + '\n'); }
    catch { /* 落地失敗不影響本回合放行 */ }
  };
  return makeStore(parsed, flush, path);
}
