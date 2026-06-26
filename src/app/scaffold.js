// 腳手架：產出「依賴 xitto-kernel 的獨立 agent 專案」（不修改 kernel，故不固化）。
// 從 templates/*.tmpl 讀樣板 → 代換 __NAME__ / __KERNEL_PATH__ → 寫到 <dir>/<name>/。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const KERNEL_ROOT = resolve(HERE, '..', '..'); // src/app/ → 套件根
const TEMPLATES = join(HERE, 'templates');

// [樣板檔, 產出檔名]
const FILES = [
  ['package.json.tmpl', 'package.json'],
  ['index.js.tmpl', 'index.js'],
  ['pack.js.tmpl', 'pack.js'],
  ['README.md.tmpl', 'README.md'],
  ['gitignore.tmpl', '.gitignore'],
];

const kernelVersion = () => {
  try { return JSON.parse(readFileSync(join(KERNEL_ROOT, 'package.json'), 'utf8')).version || '0.1.0'; }
  catch { return '0.1.0'; }
};

/**
 * 產生一個獨立 agent 專案。
 * @param {string} name                    agent 名（字母/數字/連字號）
 * @param {{ dir?: string, local?: boolean, kernelPath?: string }} [opts]
 *        dir：產出根目錄（預設 cwd）；local：用 file: 依賴本機 kernel（開發用，預設用 npm 正式版本）
 * @returns {{ target: string, files: string[], dep: string }}
 */
export function newAgent(name, { dir = process.cwd(), local = false, kernelPath = KERNEL_ROOT } = {}) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw new Error(`agent 名稱不合法：「${name}」（只能用字母/數字/連字號，且不以連字號開頭）`);
  }
  const target = join(dir, name);
  if (existsSync(target)) throw new Error(`目錄已存在：${target}`);

  // 依賴：預設用 npm 正式版本（^x.y.z）；--local 用 file: 指向本機 kernel（開發測試用）
  const dep = local ? `file:${kernelPath}` : `^${kernelVersion()}`;

  mkdirSync(target, { recursive: true });
  const subst = (s) => s.replaceAll('__NAME__', name).replaceAll('__KERNEL_DEP__', dep);
  for (const [tmpl, outName] of FILES) {
    writeFileSync(join(target, outName), subst(readFileSync(join(TEMPLATES, tmpl), 'utf8')));
  }
  return { target, files: FILES.map(([, o]) => o), dep };
}
