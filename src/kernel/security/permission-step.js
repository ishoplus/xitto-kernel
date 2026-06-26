// 守衛鏈第 5 格：真實權限/沙箱（領域無關，metadata 驅動）。
// 對標 xitto-code permissions.js，但不寫死 READ_ONLY/SHELL_TOOLS 名單——
// 「唯讀」「可沙箱」皆由工具自帶 metadata 決定，故任何領域通用。
// 檢查順序：deny → 沙箱靜態策略違規 → 危險命令 → 命令簽章白名單 / 確認。
import { sandboxViolation } from './sandbox.js';
import { dangerousReason } from './danger.js';
import { commandSignature } from './allow.js';

/**
 * @param {Object} o
 * @param {{ get: (name: string) => object }} o.registry
 * @param {() => boolean} [o.getSandbox]                沙箱是否開啟
 * @param {() => object} [o.getSandboxConfig]           沙箱策略（blockNetwork/allowWritePrefixes）
 * @param {string[]} [o.deny]                           禁止的工具名 / "bash:<簽章>"
 * @param {(name: string, args: object, danger: string|null) => Promise<'yes'|'no'|'always'|'command'>} [o.confirm]
 *        互動確認；不提供（headless）時：危險命令一律擋、其餘放行（沙箱靜態違規仍先擋）。
 * @returns {(ctx: { name: string, args: object }) => Promise<import('../../types.js').PolicyDecision>}
 */
export function createPermissionStep({ registry, getSandbox, getSandboxConfig, deny = [], confirm }) {
  const denySet = new Set(deny);
  const allowedSignatures = new Set(); // session 內「允許此命令簽章全部」
  const alwaysTools = new Set();       // session 內「允許此工具全部」（使用者選 always）

  return async function permission(ctx) {
    const name = ctx.name;
    const tool = registry.get(name);
    if (!tool) return { block: true, reason: `未知工具：${name}` };
    if (tool.readOnly === true) return undefined; // metadata 驅動：唯讀自動放行

    const cmd = ctx.args?.command || ctx.args?.cmd || '';
    const isShell = tool.sandboxable === true || typeof cmd === 'string' && cmd.length > 0;
    const sig = isShell ? commandSignature(cmd) : null;

    // 1) deny 規則優先於一切
    if (denySet.has(name) || (sig && denySet.has(`bash:${sig}`))) {
      return { block: true, reason: `${name}${sig ? `（${sig}）` : ''} 已被 deny 規則禁止。` };
    }

    // 2) 沙箱靜態策略：違規（網路/提權/越界寫入）直接擋，不執行也不詢問
    if (isShell && getSandbox?.()) {
      const v = sandboxViolation(cmd, getSandboxConfig?.() || {});
      if (v) return { block: true, reason: `${v}。可關閉沙箱或調整策略。` };
    }

    // 3) 危險命令：即使 always-allow / 無 confirm 也強制把關（headless 直接擋）
    const danger = isShell ? dangerousReason(cmd) : null;

    // 4) 非危險：本工具/命令簽章已 always-allow → 直接過；headless（無 confirm）→ 放行
    if (!danger) {
      if (alwaysTools.has(name) || (sig && allowedSignatures.has(sig))) return undefined;
      if (!confirm) return undefined;
    } else if (!confirm) {
      return { block: true, reason: `偵測到危險命令（${danger}），headless 模式下拒絕執行。` };
    }

    // 5) 互動確認（危險命令即使選 always 也只放行這次，不永久放行）
    const decision = await confirm(name, ctx.args, danger);
    if (decision === 'always' && !danger) { alwaysTools.add(name); return undefined; }
    if (decision === 'command' && sig && !danger) { allowedSignatures.add(sig); return undefined; }
    if (decision === 'yes') return undefined;
    return { block: true, reason: `使用者拒絕執行 ${name}。` };
  };
}
