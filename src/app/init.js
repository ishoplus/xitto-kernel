// 首次啟動導引：互動式產生 ~/.xitto-code/providers.json。
// 內建常見 provider 範本（MiniMax / Anthropic / OpenAI / DeepSeek / 自訂），
// 引導選 provider → 填 model → 處理 API key（環境變數或內嵌），寫檔不覆寫既有設定。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';

const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const green = e(32); const gray = e(90); const cyan = e(36); const yellow = e(33); const bold = e(1); const red = e(31);

// provider 範本（沿用實測可用的格式；baseUrl/api/model 皆可在引導中改）
const PRESETS = {
  minimax: { label: 'MiniMax（M2.7，anthropic 相容）', api: 'anthropic-messages', baseUrl: 'https://api.minimaxi.com/anthropic', env: 'MINIMAX_API_KEY', model: { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 1000192, maxTokens: 131072 } },
  anthropic: { label: 'Anthropic Claude', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', env: 'ANTHROPIC_API_KEY', model: { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxTokens: 64000 } },
  openai: { label: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', model: { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 16384 } },
  deepseek: { label: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', env: 'DEEPSEEK_API_KEY', model: { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000, maxTokens: 8192 } },
  custom: { label: '自訂（手動填全部）', api: 'openai-completions', baseUrl: '', env: 'LLM_API_KEY', model: { id: '', name: '', contextWindow: 32000, maxTokens: 4096 } },
};

const PATH = () => process.env.XITTO_CODE_CONFIG || join(homedir(), '.xitto-code', 'providers.json');

export { PRESETS };

// 純函數：把答案組成 providers.json 結構（合併既有 providers）。互動殼與測試共用。
export function buildConfig(a, existing) {
  const cfg = existing && existing.providers ? existing : { defaultModel: a.modelId, providers: {} };
  cfg.providers = cfg.providers || {};
  cfg.providers[a.providerName] = {
    baseUrl: a.baseUrl, apiKey: a.apiKey, api: a.api,
    models: [{ id: a.modelId, name: a.modelName || a.modelId, contextWindow: a.contextWindow, maxTokens: a.maxTokens }],
  };
  cfg.defaultModel = a.modelId;
  return cfg;
}

// pipe-safe 逐行讀取：把 'line' 事件排入佇列，即使管線一次送進整批輸入也能依序消費
// （readline/promises 的 question() 在非 TTY 管線下會丟失已緩衝的行）。
function makeAsker() {
  const rl = createInterface({ input: process.stdin });
  const queue = []; const waiters = []; let closed = false;
  rl.on('line', (l) => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  const nextLine = () => new Promise((res) => { if (queue.length) res(queue.shift()); else if (closed) res(null); else waiters.push(res); });
  return {
    close: () => rl.close(),
    ask: async (q, def) => {
      process.stdout.write(gray(q + (def ? ` [${def}]` : '') + ' '));
      const line = await nextLine();
      return ((line == null ? '' : line).trim()) || def || '';
    },
  };
}

export async function runInit(argv = []) {
  const force = argv.includes('--force');
  const path = PATH();
  const io = makeAsker();
  const rl = { close: io.close };
  const ask = io.ask;

  try {
    console.log('\n' + bold('🚀 xitto-kernel 首次設定') + gray('  —— 建立 LLM provider 設定'));
    console.log(gray(`設定檔：${path}\n`));

    // 既有檔保護
    if (existsSync(path) && !force) {
      console.log(yellow(`已存在設定檔。`) + gray(' 用 `xitto-kernel init --force` 覆寫，或直接編輯該檔。'));
      let cfg; try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { /* 壞檔忽略 */ }
      if (cfg) {
        const names = Object.keys(cfg.providers || {});
        console.log(gray(`  目前 provider：${names.join(', ') || '(無)'}　預設 model：${cfg.defaultModel || '(未設)'}`));
      }
      rl.close();
      return;
    }

    // 1) 選 provider
    const keys = Object.keys(PRESETS);
    console.log(bold('1) 選 LLM provider：'));
    keys.forEach((k, i) => console.log(`   ${cyan(String(i + 1))}. ${PRESETS[k].label}`));
    const pick = await ask('輸入編號', '1');
    const presetKey = keys[(parseInt(pick, 10) || 1) - 1] || 'minimax';
    const preset = PRESETS[presetKey];
    console.log(green(`   → ${preset.label}\n`));

    // 2) 連線 / model
    console.log(bold('2) 連線與 model：'));
    const providerName = await ask('provider 名稱（providers.json 的鍵）', presetKey);
    const baseUrl = await ask('baseUrl', preset.baseUrl);
    const api = await ask('api 型別（anthropic-messages | openai-completions）', preset.api);
    const modelId = await ask('model id', preset.model.id);
    const modelName = await ask('model 顯示名', preset.model.name || modelId);
    const contextWindow = parseInt(await ask('contextWindow', String(preset.model.contextWindow)), 10) || preset.model.contextWindow;
    const maxTokens = parseInt(await ask('maxTokens', String(preset.model.maxTokens)), 10) || preset.model.maxTokens;
    if (!modelId) { console.log(red('\nmodel id 不可空，已取消。')); rl.close(); return; }

    // 3) API key：環境變數（建議）或內嵌
    console.log('\n' + bold('3) API key：'));
    console.log(gray('   a) 用環境變數參照（建議，金鑰不落地在設定檔）'));
    console.log(gray('   b) 現在貼上金鑰（直接存進設定檔，檔案在你家目錄）'));
    const mode = (await ask('選 a 或 b', 'a')).toLowerCase();
    let apiKey; let envHint = '';
    if (mode === 'b') {
      const k = await ask('貼上 API key', '');
      apiKey = k;
      if (!k) console.log(yellow('   （未填，稍後請手動補上 apiKey）'));
    } else {
      const envName = await ask('環境變數名', preset.env);
      apiKey = '${' + envName + '}';
      envHint = envName;
    }

    // 組設定（保留既有 providers，--force 時合併）
    let existing; if (existsSync(path)) { try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { /* 壞檔重建 */ } }
    const cfg = buildConfig({ providerName, baseUrl, api, modelId, modelName, contextWindow, maxTokens, apiKey }, existing);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    console.log('\n' + green('✓ 已寫入 ') + path);
    if (envHint) {
      console.log('\n' + bold('下一步：設定環境變數（金鑰）'));
      console.log(gray(`  export ${envHint}="你的金鑰"   # 加進 ~/.zshrc 永久生效`));
    }
    console.log('\n' + bold('啟動：'));
    console.log(green('  xitto-kernel') + gray('               # coding pack，互動對話'));
    console.log(green('  xitto-kernel --tui') + gray('         # 完整 Ink TUI（真實終端）'));
    console.log(green('  xitto-kernel --pack general') + gray(' # 通用 agent'));
    console.log('');
  } finally {
    rl.close();
  }
}
