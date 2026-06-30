// App 進入點：解析參數 → 載入 model（providers.json）→ 選 pack → 啟動 CLI。
// 子指令：new-agent <name> → 產出依賴 kernel 的獨立 agent 專案。
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { loadModel } from './providers.js';
import { runCli } from './cli.js';
import { runTui } from './tui-run.js';
import { newAgent } from './scaffold.js';
import { runInit } from './init.js';
import { createKernel } from '../kernel/index.js';
import { loadMcpTools } from '../kernel/mcp.js';
import { createCodingPack } from '../packs/coding/index.js';
import { createDataQueryPack } from '../packs/data-query/index.js';
import { createNotesPack } from '../packs/notes/index.js';
import { createGeneralPack } from '../packs/general/index.js';
import { createDeepResearchPack } from '../packs/deep-research/index.js';
import { createDevopsPack } from '../packs/devops/index.js';
import { createPatentPack } from '../packs/patent/index.js';
import { createUiuxPack } from '../packs/uiux/index.js';

const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const green = e(32); const gray = e(90); const red = e(31); const cyan = e(36); const yellow = e(33);

const PACKS = {
  coding: createCodingPack,
  'data-query': createDataQueryPack,
  notes: createNotesPack,
  general: createGeneralPack,
  'deep-research': createDeepResearchPack,
  devops: createDevopsPack,
  patent: createPatentPack,
  uiux: createUiuxPack,
};

export async function main(argv = process.argv.slice(2)) {
  // 子指令：init —— 首次設定導引，產生 providers.json
  if (argv[0] === 'init') { await runInit(argv.slice(1)); return; }

  // 子指令：serve —— 啟動 Web 前端（🪄 許願台 + 對話頁 /chat）
  if (argv[0] === 'serve') { await runServe(argv.slice(1)); return; }

  // 子指令：map —— 批次可寫 map-verify（逐項轉換+驗收，未通過自動回滾）
  if (argv[0] === 'map') { await runMap(argv.slice(1)); return; }

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

  let model, getApiKey, resolveModel;
  try { ({ model, getApiKey, resolveModel } = loadModel(opts.model)); }
  catch (err) {
    // 沒設定 + 真實終端：直接帶進設定導引，完成後續跑；非 TTY 才只給提示
    if (err.noConfig && process.stdin.isTTY) {
      console.log(cyan('首次使用，沒找到 providers.json —— 進入設定導引。') + gray('（按 Ctrl+C 取消）'));
      await runInit([]);
      try { ({ model, getApiKey, resolveModel } = loadModel(opts.model)); }
      catch (err2) {
        console.error(red(err2.message));
        console.error(gray(err2.noConfig ? '（未完成設定，已取消）' : '（設定好像缺東西，可編輯該檔或重跑 `xitto-kernel init`）'));
        process.exit(1);
      }
    } else {
      console.error(red(err.message));
      if (err.noConfig) {
        console.error('\n' + cyan('首次使用？') + ' 跑一次設定導引：');
        console.error(green('  xitto-kernel init') + gray('   # 選 provider、填 model、設定 API key'));
      }
      process.exit(1);
    }
  }

  // 工作目錄：本地端依使用者選擇的目錄（--cwd）生成；未指定才退回 process.cwd()。
  // 不存在會自動建立；指到既有檔案則報錯。沙箱與 fs 工具都以此為根。
  let cwd;
  try { cwd = resolveCwd(opts.cwd); }
  catch (err) { console.error(red(err.message)); process.exit(1); }

  // MCP：啟動時連 .xitto-kernel/<pack>/mcp.json 的 server，工具以 extraTools 注入
  const mcp = await loadMcpTools(join(cwd, '.xitto-kernel', opts.pack, 'mcp.json'), (m) => console.log(gray(`  [MCP] ${m}`)));

  // --goal "..."：headless 自主循環（給目標、自己做到完成）後退出，不進互動 CLI
  if (opts.goal) {
    const kernel = createKernel(make({ cwd }), {
      model, getApiKey, resolveModel, extraTools: mcp.tools,
      sandbox: { enabled: opts.sandbox }, getSandbox: () => opts.sandbox,
      confirm: opts.yes ? (async () => 'yes') : undefined, // headless：--yes 才自動核准 mutating
    });
    console.log(cyan('🎯 目標：') + opts.goal + gray(`  ·  ${opts.pack} pack · ${model.id}`));
    const res = await kernel.runOutcome(opts.goal, {
      onRound: ({ round, maxRounds }) => console.log(yellow(`\n🔁 第 ${round}/${maxRounds} 輪`)),
      onCheck: ({ done, remaining }) => console.log(done ? green('  ✓ 驗收：已達成') : gray(`  ↻ 驗收：${remaining}`)),
      onEvent: (ev) => {
        if (ev.type === 'tool_execution_start') console.log(yellow(`  ⚙ ${ev.toolName}`) + gray('(' + JSON.stringify(ev.args).slice(0, 80) + ')'));
        if (ev.type === 'tool_execution_end') console.log(ev.isError ? red('    ⎿ ✗') : gray('    ⎿ ✓'));
      },
    });
    // 交付物（對話只是過程，這才是產品）
    const why = res.stalled ? '無進展停止' : res.aborted ? '中斷' : '到上限';
    console.log('\n' + (res.done ? green(`✅ 已交付（${res.rounds} 輪）`) : yellow(`⚠ 未完成（${why}，${res.rounds} 輪）`)));
    const { created, modified } = res.artifacts;
    if (created.length || modified.length) {
      console.log(cyan('📦 產出檔案：'));
      created.forEach((f) => console.log(green(`   + ${f}`)));
      modified.forEach((f) => console.log(yellow(`   ~ ${f}`)));
    } else console.log(gray('   （沒有檔案變動）'));
    if (res.summary) console.log(cyan('📝 摘要：') + gray(res.summary.slice(0, 400)));
    try { await mcp.close(); } catch { /* 略 */ }
    process.exit(res.done ? 0 : 1);
  }

  if (opts.tui && process.stdin.isTTY) {
    runTui({ pack: make({ cwd }), model, getApiKey, resolveModel, sandbox: opts.sandbox, resume: opts.resume, cwd });
    return;
  }
  if (opts.tui) console.error(gray('（--tui 需要真實終端，退回一般 CLI）'));

  runCli({
    pack: make({ cwd }), model, getApiKey, resolveModel,
    sandbox: opts.sandbox, resume: opts.resume, auto: opts.yes,
    extraTools: mcp.tools, onExit: mcp.close,
  });
}

// 把使用者選的目錄解析成可用的工作目錄（絕對路徑）：相對路徑以 process.cwd() 為基準展開，
// 不存在則建立，指到既有檔案則拋錯。未指定 → 用 process.cwd()。
function resolveCwd(dir) {
  if (!dir) return process.cwd();
  const full = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  if (existsSync(full)) {
    if (!statSync(full).isDirectory()) throw new Error(`--cwd 指到的不是目錄：${full}`);
    return full;
  }
  try { mkdirSync(full, { recursive: true }); } catch (e) { throw new Error(`無法建立工作目錄 ${full}：${e.message}`); }
  return full;
}

// serve：啟動 Web 前端（許願台 + 對話頁）。旗標映射到 startServer(opts)；沿用 providers.json 載 model。
async function runServe(args) {
  const o = { local: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return printServeHelp();
    else if (a === '--port' || a === '-p') o.port = Number(args[++i]);
    else if (a === '--token') o.token = args[++i];
    else if (a === '--local') o.local = true;
    else if (a === '--sandbox') o.sandbox = true;
    else if (a === '--no-sandbox') o.sandbox = false;
    else if (a === '--concurrency') o.concurrency = Number(args[++i]);
    else if (a === '--model') o.modelId = args[++i];
  }
  let model, getApiKey, resolveModel;
  try { ({ model, getApiKey, resolveModel } = loadModel(o.modelId)); }
  catch (err) {
    console.error(red(err.message));
    if (err.noConfig) {
      console.error('\n' + cyan('首次使用？') + ' 先跑設定導引：');
      console.error(green('  xitto-kernel init') + gray('   # 選 provider、填 model、設定 API key'));
    }
    process.exit(1);
  }
  const { startServer } = await import('./server.js');
  startServer({ ...o, model, getApiKey, resolveModel });
}

function printServeHelp() {
  console.log([
    'xitto-kernel serve — 啟動 Web 前端（🪄 許願台 + 對話頁 /chat）',
    '',
    '用法:',
    '  xitto-kernel serve [--port <n>] [--local] [--token <t>] [--no-sandbox] [--concurrency <n>] [--model <id>]',
    '',
    '  --port, -p <n>     監聽埠（預設 8787）',
    '  --local            本地模式：可瀏覽/選真實資料夾、顯示檔案位置',
    '  --token <t>        API token（預設 dev-token；對外請務必設定）',
    '  --no-sandbox       關閉沙箱（預設開；macOS=Seatbelt 真隔離）',
    '  --concurrency <n>  背景任務同時數（預設 2）',
    '  --model <id>       指定 model（預設用 providers.json 的 defaultModel）',
    '',
    '啟動後瀏覽器開 http://localhost:<port>/ 即用。需先 `xitto-kernel init` 設好 providers.json。',
  ].join('\n'));
}

// map：批次可寫 map-verify。讀 items JSON（[字串 | {task,verify}]），逐項轉換+驗收，未通過自動回滾。
async function runMap(args) {
  const o = { pack: 'coding', sandbox: false };
  let file = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return printMapHelp();
    else if (a === '--pack') o.pack = args[++i];
    else if (a === '--cwd' || a === '--dir' || a === '-C') o.cwd = args[++i];
    else if (a === '--sandbox') o.sandbox = true;
    else if (a === '--model') o.model = args[++i];
    else if (!a.startsWith('-') && !file) file = a;
  }
  if (!file) { printMapHelp(); process.exit(1); }
  let items;
  try { items = JSON.parse(readFileSync(resolve(file), 'utf8')); }
  catch (e) { console.error(red('讀取 items 檔失敗：' + e.message)); process.exit(1); }
  if (!Array.isArray(items) || !items.length) { console.error(red('items 檔需為非空 JSON 陣列（字串，或 {task, verify} 物件）')); process.exit(1); }

  const make = PACKS[o.pack];
  if (!make) { console.error(red(`未知 pack「${o.pack}」。可用：${Object.keys(PACKS).join(', ')}`)); process.exit(1); }
  let model, getApiKey, resolveModel;
  try { ({ model, getApiKey, resolveModel } = loadModel(o.model)); }
  catch (err) {
    console.error(red(err.message));
    if (err.noConfig) { console.error('\n' + cyan('首次使用？') + ' 先跑：' + green('  xitto-kernel init')); }
    process.exit(1);
  }
  let cwd;
  try { cwd = resolveCwd(o.cwd); }
  catch (err) { console.error(red(err.message)); process.exit(1); }

  const kernel = createKernel(make({ cwd }), {
    model, getApiKey, resolveModel,
    sandbox: { enabled: o.sandbox }, getSandbox: () => o.sandbox,
    confirm: async () => 'yes', // 批次非互動：自動核准 mutating；安全靠 verify 通過才保留、未通過回滾（+ 可選沙箱）
  });
  console.log(cyan(`🗺  map-verify：${items.length} 項`) + gray(`  ·  ${o.pack} pack · ${model.id}${o.sandbox ? ' · 沙箱開' : ''}`));
  const out = await kernel.mapVerify(items, {
    onItem: (r) => console.log(`  ${r.ok ? green('✓') : (r.verified ? red('✗ 已回滾') : yellow('· 未驗'))} ${gray(String(r.task).slice(0, 70))}`),
  });
  console.log('\n' + (out.failed
    ? yellow(`完成：${out.passed}/${out.total} 通過，${out.failed} 未通過（已回滾）`)
    : green(`✅ 全部通過：${out.passed}/${out.total}`)));
  process.exit(out.failed ? 1 : 0);
}

function printMapHelp() {
  console.log([
    'xitto-kernel map — 批次可寫 map-verify（逐項轉換 + 驗收，未通過自動回滾）',
    '',
    '用法:',
    '  xitto-kernel map <items.json> [--pack <name>] [--cwd <dir>] [--sandbox] [--model <id>]',
    '',
    'items.json：非空 JSON 陣列，每項可為',
    '  "字串任務"                              # 用 pack.verify 當驗收（若 pack 有）',
    '  { "task": "...", "verify": "shell 指令" }  # 用該指令當驗收（exit 0 = 通過）',
    '',
    '行為：逐項跑可寫回合 → 驗收 → 通過保留、未通過 undo 回滾該項所有檔案改動。',
    '安全：批次自動核准 mutating；安全來自「驗收通過才保留、未通過回滾」(+ 可選 --sandbox)。',
  ].join('\n'));
}

function parse(argv) {
  const o = { pack: 'coding', model: undefined, sandbox: false, help: false, resume: null, yes: false, goal: null, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--pack') o.pack = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--cwd' || a === '--dir' || a === '-C') o.cwd = argv[++i];
    else if (a === '--sandbox') o.sandbox = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--tui') o.tui = true;
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
    '  xitto-kernel init                                        首次設定導引（產生 providers.json）',
    '  xitto-kernel [--pack <name>] [--cwd <dir>] [--model <id>] [--sandbox] [--resume [id]] [--yes]   互動跑內建 pack',
    '  xitto-kernel --pack general --goal "..." [--yes]         目標驅動自主循環（headless）',
    '  xitto-kernel serve [--port <n>] [--local]                啟動 Web 前端（🪄 許願台 + 對話頁）',
    '  xitto-kernel map <items.json> [--pack <name>] [--cwd <dir>]  批次可寫 map-verify（逐項轉換+驗收，未過回滾）',
    '  xitto-kernel new-agent <name>                            產出依賴 kernel 的獨立 agent 專案',
    '',
    '  --pack <name>   選擇內建 DomainPack（coding | data-query | notes | general | deep-research | devops | patent | uiux；預設 coding）',
    '  --cwd <dir>     工作目錄（沙箱根；相對路徑以當前目錄展開，不存在自動建立。別名 --dir / -C；預設當前目錄）',
    '  --goal "..."    給目標，agent 自主反覆做到完成（建議搭配 --pack general）',
    '  --model <id>    指定 model（預設用 providers.json 的 defaultModel）',
    '  --sandbox       啟動即開啟沙箱（macOS=Seatbelt 真隔離）',
    '  --tui           完整 Ink TUI（持久狀態列、串流轉錄、Esc 中斷；需真實終端）',
    '  --resume [id]   接續上次 session（不給 id 接最近一次）',
    '  --yes, -y       自動核准 mutating 工具（headless / 自主循環常用）',
    '  --help          顯示說明',
    '',
    '首次使用先跑 `xitto-kernel init` 建立 ~/.xitto-code/providers.json（已是 xitto-code 使用者可直接共用）。',
    'new-agent 產出的是獨立專案，import xitto-kernel 而非修改它——升級不固化。',
  ].join('\n'));
}
