// 工具註冊表 — metadata 驅動，取代 xitto-code 寫死的 MUTATING/READ_ONLY 領域名單。
// kernel 只認工具自帶的 mutating/readOnly/sandboxable，不認識任何具體領域。
// 對應 docs/03-kernel-contract.md「D. 工具 metadata 驅動」。

/** @param {import('../types.js').Tool} t */
export const isReadOnly = (t) => t?.readOnly === true;
/** @param {import('../types.js').Tool} t */
export const isMutating = (t) => t?.mutating === true;
/** @param {import('../types.js').Tool} t */
export const isSandboxable = (t) => t?.sandboxable === true;

/**
 * 推導「會改動狀態」的工具名集合：pack 顯式給 mutatingTools 就用，否則從工具 metadata 推。
 * @param {import('../types.js').DomainPack} pack
 * @param {import('../types.js').Tool[]} tools
 * @returns {string[]}
 */
export function deriveMutatingTools(pack, tools) {
  if (Array.isArray(pack.mutatingTools)) return [...new Set(pack.mutatingTools)];
  return [...new Set(tools.filter(isMutating).map((t) => t.name))];
}

/**
 * 建立工具註冊表（名稱唯一）。
 * @param {import('../types.js').Tool[]} tools
 */
export function createToolRegistry(tools) {
  if (!Array.isArray(tools)) throw new Error('tools 必須是陣列');
  const byName = new Map();
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || !t.name) throw new Error('工具缺少有效的 name');
    if (typeof t.execute !== 'function') throw new Error(`工具「${t.name}」缺少 execute 函數`);
    if (byName.has(t.name)) throw new Error(`工具名重複：${t.name}`);
    byName.set(t.name, t);
  }
  return {
    all: () => [...byName.values()],
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    names: () => [...byName.keys()],
    readOnlyNames: () => [...byName.values()].filter(isReadOnly).map((t) => t.name),
    mutatingNames: () => [...byName.values()].filter(isMutating).map((t) => t.name),
    sandboxableNames: () => [...byName.values()].filter(isSandboxable).map((t) => t.name),
  };
}
