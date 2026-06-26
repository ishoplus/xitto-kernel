// 對話持久化 / resume — kernel 內建。每輪結束存 messages 到 <dir>/<id>.json，可續接。
// 對標 xitto-code session.js。id 為 YYYYMMDD-HHMMSS。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const pad = (n) => String(n).padStart(2, '0');

export function newSessionId(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function saveSession(dir, id, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, ...data, savedAt: Date.now() }, null, 2));
}

export function loadSession(dir, id) {
  const p = join(dir, `${id}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function listSessions(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadSession(dir, f.replace(/\.json$/, '')))
    .filter(Boolean)
    .map((d) => ({ id: d.id, count: d.messages?.length || 0, model: d.model?.id, savedAt: d.savedAt || 0 }))
    // savedAt 新→舊；同毫秒時用 id 遞減（id 為時間戳，字典序=時間序）打破平手，確保 latest 確定性
    .sort((a, b) => (b.savedAt - a.savedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export function latestSession(dir) {
  return listSessions(dir)[0] || null;
}
