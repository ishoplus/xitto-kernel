// 所有 pack 共用的輸出規範（house style）。抽在此處為單一真源，避免每個 pack 各寫一份、
// 也讓未來新增/調整規則只改一處。各 pack 以 withBaseRules(SYSTEM_PROMPT) 統一注入。
//
// 注意：這是規範「agent 的輸出」（回覆/程式碼/檔案內容），與前端產品層的功能性 UI 圖示無關。
export const BASE_OUTPUT_RULES = [
  '輸出避免使用 emoji（回覆、程式碼、檔案內容皆然），除非使用者明確要求。',
];

// 把 pack 專屬 prompt 併上共用輸出規範，回傳最終 system prompt 字串。
export function withBaseRules(prompt) {
  const base = BASE_OUTPUT_RULES.map((r) => '- ' + r).join('\n');
  const head = String(prompt == null ? '' : prompt).replace(/\s+$/, '');
  return base ? head + '\n' + base : head;
}
