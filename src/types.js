// 核心型別（JSDoc，設計即文件；本檔無 runtime 程式碼，只給編輯器/讀者型別參考）。
// 對應設計文件 docs/02-domain-pack-spec.md 與 docs/03-kernel-contract.md。

/**
 * kernel 的通用工具原語。kernel 不在乎工具做什麼，只在乎這個形狀。
 * 這就是 xitto-code 既有的工具形狀，故現有工具不改即可用。
 * @typedef {Object} Tool
 * @property {string} name
 * @property {string} label                          UI 顯示用短名
 * @property {string} description                     給模型看的用途
 * @property {object} parameters                      JSON Schema
 * @property {(id: string, params: object, signal?: AbortSignal, onUpdate?: Function, ctx?: object) => Promise<ToolResult>} execute
 * @property {boolean} [mutating]                     是否會改動狀態（預設 false）。kernel 據此推導 mutatingTools。
 * @property {boolean} [readOnly]                     是否唯讀（唯讀工具 kernel 自動放行、不問權限）。
 * @property {boolean} [sandboxable]                  執行可否被沙箱包裹（走 shell 的工具）。預設 false。
 */

/**
 * @typedef {Object} ToolResult
 * @property {Array<{type: string, text?: string, data?: string, mimeType?: string}>} content
 * @property {object} [details]
 */

/**
 * 守衛/工具可拿到的 kernel 服務（依賴注入，便於 fake kernel 單測）。
 * 皆為領域無關能力。詳見 docs/03-kernel-contract.md。
 * @typedef {Object} KernelServices
 * @property {string} cwd
 * @property {{ save: Function, list: Function }} [memory]
 * @property {Function} [spawn]                       派唯讀子 agent 做聚焦調查
 * @property {Function} [ask]                         向使用者提問
 * @property {Function} [notify]                      推訊息到 transcript
 * @property {object} [model]                         當前模型（provider 無關）
 * @property {{ isOn: Function, wrap: Function }} [sandbox]
 */

/**
 * 守衛決策：undefined = 放行；{block:true,reason} = 擋下並把 reason 餵回模型。
 * @typedef {undefined | { block: true, reason: string }} PolicyDecision
 */

/**
 * 工具前領域守衛（守衛鏈第 3 格；pack 唯一能插的位置）。
 * @typedef {Object} PreToolPolicy
 * @property {(ctx: object, services: KernelServices) => PolicyDecision | Promise<PolicyDecision>} check
 */

/**
 * 每輪收尾的領域自我驗收。
 * @typedef {Object} VerifyPolicy
 * @property {(ctx: object) => Promise<{ ok: boolean, output?: string }>} run
 * @property {(ctx: object) => boolean} [shouldRun]   是否該跑（編碼：本輪有改動才跑）
 * @property {number} [maxRounds]                     回灌修正上限（預設 2）
 */

/**
 * 領域的權限/沙箱預設（會被使用者 settings.json 覆蓋）。
 * @typedef {Object} PermissionPolicy
 * @property {'default'|'acceptEdits'|'plan'} [defaultMode]
 * @property {boolean|object} [sandbox]
 * @property {string[]} [allow]
 * @property {string[]} [deny]
 */

/**
 * 一個領域 = 一份注入 kernel 的 DomainPack。必填三欄、選填六欄。
 * @typedef {Object} DomainPack
 * @property {string} name
 * @property {() => Tool[]} tools
 * @property {string} systemPrompt
 * @property {string[]} [contextFiles]
 * @property {string[]} [mutatingTools]
 * @property {VerifyPolicy} [verify]
 * @property {PreToolPolicy} [preToolPolicy]
 * @property {PermissionPolicy} [permissionPolicy]
 * @property {string} [memoryGuide]
 */

export {}; // 純型別模組
