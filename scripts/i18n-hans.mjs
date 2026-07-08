// 從 zh-Hant canonical 源表自動生成 zh-Hans（繁→簡，確定性方向，近無損）。
// 用法：npm i -D opencc-js && npm run i18n:hans
// 只轉「值」，鍵原樣保留；用 tw→cn 詞彙級轉換（檔案→文件、資料夾→文件夾…），非僅字形（檔→档）。
// 產物僅供起點——請人工快掃一眼（少數台灣用語 opencc 詞庫未覆蓋時手改）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'web', 'shared', 'i18n');
const SRC = join(DIR, 'zh-Hant.js');
const OUT = join(DIR, 'zh-Hans.js');

// 從 `window.__I18N_DICTS__['zh-Hant'] = {...}` 檔案安全取出物件（不依賴瀏覽器 window）。
function loadDict(file) {
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('window', readFileSync(file, 'utf8'))(win);
  return (win.__I18N_DICTS__ && win.__I18N_DICTS__['zh-Hant']) || {};
}

let Converter;
try { ({ Converter } = await import('opencc-js')); }
catch { console.error('缺少 opencc-js。請先安裝：npm i -D opencc-js'); process.exit(1); }

const convert = Converter({ from: 'twp', to: 'cn' }); // 台灣正體（含詞彙表）→ 大陸簡體，'tw' 只轉字形，'twp' 才會做詞彙級轉換
const src = loadDict(SRC);
const out = {};
for (const [k, v] of Object.entries(src)) out[k] = convert(String(v));

const body = Object.entries(out).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
writeFileSync(OUT,
  '// 简体中文（由 scripts/i18n-hans.mjs 从 zh-Hant 经 opencc 生成；勿手改，改源表 zh-Hant.js 后重跑）。\n' +
  "window.__I18N_DICTS__ = window.__I18N_DICTS__ || {};\n" +
  "window.__I18N_DICTS__['zh-Hans'] = {\n" + body + '\n};\n');
console.log(`✓ 已生成 ${Object.keys(out).length} 條 → ${OUT}`);
