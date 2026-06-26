// 危險 bash 命令偵測 — 即使使用者對 bash 選了「本次全部允許」，命中這些高破壞性模式時
// 仍強制二次確認（且不因「always」而永久放行）。高精準、低誤報為原則：只攔真正不可逆/系統級操作。
// 回傳一句中文原因字串，安全則回傳 null。

const RULES = [
  // rm 遞迴 + 強制刪除（-rf / -fr / -r -f 任意組合）
  [(c) => /\brm\b/.test(c) && /-\w*r/.test(c) && /-\w*f/.test(c), 'rm 遞迴強制刪除（不可復原）'],
  // 刪到根目錄 / 家目錄 / 萬用字元根
  [(c) => /\brm\b[\s\S]*\s(-\w+\s+)*(\/|~|\$home|\/\*)(\s|$)/.test(c), 'rm 目標為根/家目錄'],
  // 下載內容直接交給 shell 執行（curl|sh、wget|bash、… | python）
  [(c) => /\b(curl|wget|fetch)\b[\s\S]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python\d?|node|perl|ruby)\b/.test(c), '下載內容直接管道給 shell 執行'],
  // fork bomb :(){ :|:& };:
  [(c, raw) => /:\(\)\s*\{[\s\S]*\|[\s\S]*&[\s\S]*\}/.test(raw) || /:\(\)\{:\|:&\};:/.test(raw.replace(/\s/g, '')), 'fork bomb'],
  // 格式化檔案系統
  [(c) => /\bmkfs(\.\w+)?\b/.test(c), '格式化檔案系統（mkfs）'],
  // dd 寫入裝置
  [(c) => /\bdd\b[\s\S]*\bof=\/dev\//.test(c), 'dd 直接寫入裝置'],
  // 重導向覆寫區塊裝置
  [(c) => />\s*\/dev\/(sd|nvme|disk|hd|mmcblk)/.test(c), '覆寫區塊裝置'],
  // 對根遞迴改權限/擁有者
  [(c) => /\b(chmod|chown)\b[\s\S]*-\w*r[\s\S]*\s\/(\s|$)/.test(c), '對根目錄遞迴 chmod/chown'],
  // 關機 / 重啟
  [(c) => /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/.test(c), '關機/重啟'],
  // 清空磁碟 via /dev/zero|null 寫整顆盤
  [(c) => /\b(cat|cp)\b[\s\S]*\/dev\/(zero|random|urandom)[\s\S]*>\s*\/dev\//.test(c), '寫入裝置（清空磁碟）'],
];

export function dangerousReason(cmd) {
  if (typeof cmd !== 'string') return null;
  const raw = cmd;
  const c = cmd.toLowerCase();
  if (!c.trim()) return null;
  for (const [test, reason] of RULES) {
    try { if (test(c, raw)) return reason; } catch { /* 規則出錯不阻塞 */ }
  }
  return null;
}
