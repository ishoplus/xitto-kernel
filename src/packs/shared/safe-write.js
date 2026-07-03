// 併發安全寫檔：原子落地 + 陳舊防護。
// 動機：會議室多人共享同一 workspace、每人一條並發 AI lane（見 app/server.js createRoomStore）。
//   ① 原子落地（tmp + rename）：別條 lane 若在寫入途中 read 同一檔，看到的是「舊全貌或新全貌」，不會是半寫檔。
//   ② 陳舊防護（可選）：整檔覆寫（write）是基於「本回合稍早讀到的內容」算出來的；若落地前該檔已被
//      別條 lane/外部改動，直接覆寫會把對方更新整個蓋掉（lost update）。偵測到 → 擋，要求重新 read。
//      edit 不需要這層：它在 execute 當下重讀當前內容再套 oldText，本就對到最新版，只需 ①。
// 全同步（無 await）→ 對其他 lane 原子：check → write → rename 之間不會被插入別條 lane 的寫入。
import { writeFileSync, renameSync, statSync, existsSync } from 'node:fs';

let seq = 0; // 唯一 tmp 名序號：同一 process 內多條 lane 併發寫「同一新檔」時，避免共用 `${p}.tmp-${pid}` 撞在一起。

/**
 * 記錄「本回合讀到此檔時的 mtime」作為覆寫基準。之後 writeAtomic 的陳舊判定與此比較。
 * @param {Map<string,number>} map  path → mtimeMs（不存在的檔記 0）
 * @param {string} p  檔案路徑（呼叫端一致用同一種 key：abs 或 realpath）
 */
export function markRead(map, p) {
  try { map.set(p, statSync(p).mtimeMs); } catch { map.set(p, 0); }
}

/**
 * 原子安全寫。
 * @param {Map<string,number>} map  同 markRead 的基準表
 * @param {string} p  目標路徑（與 map 用同一種 key）
 * @param {string} body  檔案內容
 * @param {boolean} [checkStale=false]  是否做陳舊防護（write 用 true；edit 用 false）
 * @returns {{ok:true}|{stale:true}}  stale 時未寫入，呼叫端轉成給模型的錯誤（提示重新 read）
 */
export function writeAtomic(map, p, body, checkStale = false) {
  // 陳舊：本回合讀過（map 有基準）、檔案現存、且現存 mtime 已超過基準 → 別人動過，別蓋。
  if (checkStale && existsSync(p) && map.has(p) && statSync(p).mtimeMs > map.get(p)) return { stale: true };
  const tmp = `${p}.tmp-${process.pid}-${seq++}`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, p);
  markRead(map, p); // 寫完更新基準：連續寫同一檔不會被自己上一次寫誤判為陳舊
  return { ok: true };
}
