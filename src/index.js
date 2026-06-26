// xitto-kernel 公開 API。
export { createKernel } from './kernel/index.js';
export { loadPack, validatePack } from './kernel/pack-loader.js';
export { createToolRegistry, deriveMutatingTools, isReadOnly, isMutating, isSandboxable } from './kernel/tool-registry.js';
export { composeGuards } from './kernel/guard-chain.js';

/**
 * 小幫手：定義一個 DomainPack（立即驗證，型別提示用）。
 * @param {import('./types.js').DomainPack} pack
 * @returns {import('./types.js').DomainPack}
 */
export function defineDomainPack(pack) {
  // 不在此丟錯，交給 createKernel/loadPack 時驗證；此函數僅為可讀性與型別錨點。
  return pack;
}
