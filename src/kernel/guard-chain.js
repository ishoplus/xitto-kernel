// beforeToolCall 守衛鏈 — kernel 固定順序，pack 只能在第 3 格插領域守衛。
// 安全性靠順序保證：pack 無法重排或跳過 permission/hooks（只能「額外多擋」）。
// 對應 docs/03-kernel-contract.md「C. beforeToolCall 守衛鏈」。

/**
 * 固定六步順序：
 *   1. planGuard       計劃模式擋 mutating 工具（kernel）
 *   2. circuitBreaker  上下文熔斷（kernel）
 *   3. packPreTool     領域守衛（PACK 唯一插槽，如 read-before-edit）
 *   4. preToolHooks    使用者 PreToolUse hooks（kernel）
 *   5. permission      權限/沙箱/危險命令/白名單（kernel）
 * 任一步回 {block:true,reason} 即短路擋下；全通過回 undefined（放行）。
 *
 * 各步驟以注入函數提供（領域無關、可 fake 測試）。未提供的步驟自動略過。
 *
 * @param {Object} steps
 * @param {Function} [steps.planGuard]
 * @param {Function} [steps.circuitBreaker]
 * @param {import('../types.js').PreToolPolicy} [steps.packPreTool]
 * @param {Function} [steps.preToolHooks]
 * @param {Function} [steps.permission]
 * @param {import('../types.js').KernelServices} [steps.services]
 * @returns {(ctx: object) => Promise<import('../types.js').PolicyDecision>}
 */
export function composeGuards({ planGuard, circuitBreaker, packPreTool, preToolHooks, permission, services } = {}) {
  // 固定順序；第 3 格是 pack 的 preToolPolicy.check（注入 services）
  const chain = [
    planGuard,
    circuitBreaker,
    packPreTool ? (ctx) => packPreTool.check(ctx, services) : null,
    preToolHooks,
    permission,
  ].filter((step) => typeof step === 'function');

  return async function runGuards(ctx) {
    for (const step of chain) {
      const decision = await step(ctx);
      if (decision && decision.block) return decision; // 短路：擋下即停，後續步驟不執行
    }
    return undefined; // 全通過 → 放行
  };
}
