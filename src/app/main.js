// App 進入點：解析參數 → 載入 model（providers.json）→ 選 pack → 啟動 CLI。
// 子指令：new-agent <name> → 產出依賴 kernel 的獨立 agent 專案。
import { join } from 'node:path';
import { loadModel } from './providers.js';
import { runCli } from './cli.js';
import { newAgent } from './scaffold.js';
import { createKernel } from '../kernel/index.js';
import { loadMcpTools } from '../kernel/mcp.js';
import { createCodingPack } from '../packs/coding/index.js';
import { createDataQueryPack } from '../packs/data-query/index.js';
import { createNotesPack } from '../packs/notes/index.js';
import { createGeneralPack } from '../packs/general/index.js';

const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const green = e(32); const gray = e(90); const red = e(31); const cyan = e(36); const yellow = e(33);

const PACKS = {
  coding: createCodingPack,
  'data-query': createDataQueryPack,
  notes: createNotesPack,
  general: createGeneralPack,
};

export async function main(argv = process.argv.slice(2)) {
  // 子指令：new-agent <name> —— 產出獨立 agent 專案（不碰 kernel）
  if (argv[0] === 'new-agent') {
    const name = argv.find((a, i) => i >= 1 && !a.startsWith('--'));
    const local = argv.includes('--local');
    try {
      const { target, files, dep } = newAgent(name, { local });
      console.log(green(`✓ 已建立獨立 agent 專案：${target}`));
      console.log(gray(`  ${files.join('  ')}  ·  依賴 xitto-kernel@${dep}`));
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

  // MCP：啟動時連 .xitto-kernel/<pack>/mcp.json 的 server，工具以 extraTools 注入
  const cwd = process.cwd();
  const mcp = await loadMcpTools(join(cwd, '.xitto-kernel', opts.pack, 'mcp.json'), (m) => console.log(gray(`  [MCP] ${m}`)));

  // --goal "..."：headless 自主循環（給目標、自己做到完成）後退出，不進互動 CLI
  if (opts.goal) {
    const kernel = createKernel(make({ cwd }), {
      model, getApiKey, extraTools: mcp.tools,
      sandbox: { enabled: opts.sandbox }, getSandbox: () => opts.sandbox,
      confirm: opts.yes ? (async () => 'yes') : undefined, // headless：--yes 才自動核准 mutating
    });
    console.log(cyan('🎯 目標：') + opts.goal + gray(`  ·  ${opts.pack} pack · ${model.id}`));
    const res = await kernel.runGoal(opts.goal, {
      onRound: ({ round, maxRounds }) => console.log(yellow(`\n🔁 第 ${round}/${maxRounds} 輪`)),
      onCheck: ({ done, remaining }) => console.log(done ? green('  ✓ 驗收：已達成') : gray(`  ↻ 驗收：${remaining}`)),
      onEvent: (ev) => {
        if (ev.type === 'tool_execution_start') console.log(yellow(`  ⚙ ${ev.toolName}`) + gray('(' + JSON.stringify(ev.args).slice(0, 80) + ')'));
        if (ev.type === 'tool_execution_end') console.log(ev.isError ? red('    ⎿ ✗') : gray('    ⎿ ✓'));
      },
    });
    console.log('\n' + (res.done ? green(`✅ 目標達成（${res.rounds} 輪）`) : yellow(`⚠ 未達成（${res.stalled ? '無進展停止' : res.aborted ? '中斷' : '到上限'}，${res.rounds} 輪）`)));
    try { await mcp.close(); } catch { /* 略 */ }
    process.exit(res.done ? 0 : 1);
  }

  runCli({
    pack: make({ cwd }), model, getApiKey,
    sandbox: opts.sandbox, resume: opts.resume, auto: opts.yes,
    extraTools: mcp.tools, onExit: mcp.close,
  });
}

function parse(argv) {
  const o = { pack: 'coding', model: undefined, sandbox: false, help: false, resume: null, yes: false, goal: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--pack') o.pack = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--sandbox') o.sandbox = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--goal') o.goal = argv[++i];
    else if (a === '--resume') { const nxt = argv[i + 1]; if (nxt && !nxt.startsWith('--')) { o.resume = nxt; i++; } else o.resume = true; }
  }
  return o;
}

function printHelp() {
  console.log([
    'xitto-kernel — 領域無關 agent 底座',
    '',
    '用法:',
    '  xitto-kernel [--pack <name>] [--model <id>] [--sandbox] [--resume [id]] [--yes]   互動跑內建 pack',
    '  xitto-kernel --pack general --goal "..." [--yes]         目標驅動自主循環（headless）',
    '  xitto-kernel new-agent <name>                            產出依賴 kernel 的獨立 agent 專案',
    '',
    '  --pack <name>   選擇內建 DomainPack（coding | data-query | notes | general；預設 coding）',
    '  --goal "..."    給目標，agent 自主反覆做到完成（建議搭配 --pack general）',
    '  --model <id>    指定 model（預設用 providers.json 的 defaultModel）',
    '  --sandbox       啟動即開啟沙箱（macOS=Seatbelt 真隔離）',
    '  --help          顯示說明',
    '',
    '需要 ~/.xitto-code/providers.json（與 xitto-code 共用）。',
    'new-agent 產出的是獨立專案，import xitto-kernel 而非修改它——升級不固化。',
  ].join('\n'));
}
