// App 進入點：解析參數 → 載入 model（providers.json）→ 選 pack → 啟動 CLI。
// 子指令：new-agent <name> → 產出依賴 kernel 的獨立 agent 專案。
import { loadModel } from './providers.js';
import { runCli } from './cli.js';
import { newAgent } from './scaffold.js';
import { createCodingPack } from '../packs/coding/index.js';
import { createDataQueryPack } from '../packs/data-query/index.js';
import { createNotesPack } from '../packs/notes/index.js';

const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const green = e(32); const gray = e(90); const red = e(31);

const PACKS = {
  coding: createCodingPack,
  'data-query': createDataQueryPack,
  notes: createNotesPack,
};

export function main(argv = process.argv.slice(2)) {
  // 子指令：new-agent <name> —— 產出獨立 agent 專案（不碰 kernel）
  if (argv[0] === 'new-agent') {
    const name = argv[1];
    try {
      const { target, files } = newAgent(name);
      console.log(green(`✓ 已建立獨立 agent 專案：${target}`));
      console.log(gray(`  ${files.join('  ')}`));
      console.log('\n下一步：');
      console.log(gray(`  cd ${name} && npm install && npm start`));
      console.log(gray('  （改 pack.js 換成你的領域；npm update xitto-kernel 升級底座，不固化）'));
    } catch (err) { console.error(red(err.message)); process.exit(1); }
    return;
  }

  const opts = parse(argv);
  if (opts.help) return printHelp();

  const make = PACKS[opts.pack];
  if (!make) { console.error(`未知 pack「${opts.pack}」。可用：${Object.keys(PACKS).join(', ')}`); process.exit(1); }

  let model, getApiKey;
  try { ({ model, getApiKey } = loadModel(opts.model)); }
  catch (err) { console.error('\x1b[31m' + err.message + '\x1b[0m'); process.exit(1); }

  runCli({ pack: make({ cwd: process.cwd() }), model, getApiKey, sandbox: opts.sandbox });
}

function parse(argv) {
  const o = { pack: 'coding', model: undefined, sandbox: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--pack') o.pack = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--sandbox') o.sandbox = true;
  }
  return o;
}

function printHelp() {
  console.log([
    'xitto-kernel — 領域無關 agent 底座',
    '',
    '用法:',
    '  xitto-kernel [--pack <name>] [--model <id>] [--sandbox]   互動跑內建 pack',
    '  xitto-kernel new-agent <name>                            產出依賴 kernel 的獨立 agent 專案',
    '',
    '  --pack <name>   選擇內建 DomainPack（coding | data-query | notes；預設 coding）',
    '  --model <id>    指定 model（預設用 providers.json 的 defaultModel）',
    '  --sandbox       啟動即開啟沙箱（macOS=Seatbelt 真隔離）',
    '  --help          顯示說明',
    '',
    '需要 ~/.xitto-code/providers.json（與 xitto-code 共用）。',
    'new-agent 產出的是獨立專案，import xitto-kernel 而非修改它——升級不固化。',
  ].join('\n'));
}
