// DomainPack 載入與驗證 — kernel 對 pack 的入口契約。
// 必填：name / tools / systemPrompt。選填欄位若提供則檢查型別。
// 對應 docs/02-domain-pack-spec.md 的「必填/選填總表」。

/**
 * 驗證一個 DomainPack，回傳錯誤訊息陣列（空陣列 = 合法）。
 * @param {import('../types.js').DomainPack} pack
 * @returns {string[]}
 */
export function validatePack(pack) {
  if (!pack || typeof pack !== 'object') return ['pack 必須是物件'];
  const errors = [];

  // ── 必填 ──
  if (typeof pack.name !== 'string' || !pack.name.trim()) errors.push('name：必填，需為非空字串');
  if (typeof pack.tools !== 'function') errors.push('tools：必填，需為函數 () => Tool[]');
  if (typeof pack.systemPrompt !== 'string' || !pack.systemPrompt.trim()) errors.push('systemPrompt：必填，需為非空字串');

  // ── 選填（提供才檢查型別）──
  if (pack.contextFiles !== undefined && !isStringArray(pack.contextFiles)) errors.push('contextFiles：需為字串陣列');
  if (pack.mutatingTools !== undefined && !isStringArray(pack.mutatingTools)) errors.push('mutatingTools：需為字串陣列');
  if (pack.verify !== undefined && typeof pack.verify?.run !== 'function') errors.push('verify.run：需為函數');
  if (pack.preToolPolicy !== undefined && typeof pack.preToolPolicy?.check !== 'function') errors.push('preToolPolicy.check：需為函數');
  if (pack.permissionPolicy !== undefined && (typeof pack.permissionPolicy !== 'object' || pack.permissionPolicy === null)) errors.push('permissionPolicy：需為物件');
  if (pack.memoryGuide !== undefined && typeof pack.memoryGuide !== 'string') errors.push('memoryGuide：需為字串');

  return errors;
}

/**
 * 載入並驗證 pack；不合法則丟出聚合錯誤。回傳原 pack（不變更）。
 * @param {import('../types.js').DomainPack} pack
 * @returns {import('../types.js').DomainPack}
 */
export function loadPack(pack) {
  const errors = validatePack(pack);
  if (errors.length) {
    throw new Error(`DomainPack「${pack?.name ?? '?'}」不合法：\n- ${errors.join('\n- ')}`);
  }
  return pack;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
