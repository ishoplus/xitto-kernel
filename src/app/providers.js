// App 層：從 providers.json 載入並組裝 model（沿用 xitto providers.json 格式）。
// 這是「provider 設定」，屬 app；kernel 本身 provider 無關（只收 model + getApiKey）。
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PATH = () => process.env.XITTO_CODE_CONFIG || join(homedir(), '.xitto-code', 'providers.json');

export function loadProvidersConfig(path = DEFAULT_PATH()) {
  if (!existsSync(path)) throw new Error(`找不到 providers.json：${path}\n（可複用 xitto-code 的 ~/.xitto-code/providers.json）`);
  return { ...JSON.parse(readFileSync(path, 'utf8')), path };
}

export function buildModel(cfg, modelId) {
  const providers = cfg.providers || {};
  const targetId = modelId || cfg.defaultModel;
  for (const [provider, pcfg] of Object.entries(providers)) {
    const m = (pcfg.models || []).find((x) => x.id === targetId);
    if (!m) continue;
    const model = {
      id: m.id, name: m.name || m.id, provider,
      api: pcfg.api || 'openai-completions', baseUrl: pcfg.baseUrl,
      reasoning: m.reasoning || false, input: m.input || ['text'], output: m.output || ['text'],
      cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow || 32000, maxTokens: m.maxTokens || 4096,
      cache: m.cache ?? pcfg.cache,
    };
    const apiKey = resolveEnv(pcfg.apiKey || '');
    return { model, getApiKey: () => apiKey };
  }
  throw new Error(`providers.json 找不到 model「${targetId}」`);
}

// 一步到位：載入設定 + 組裝指定（或預設）model
export function loadModel(modelId, path) {
  return buildModel(loadProvidersConfig(path), modelId);
}

const resolveEnv = (v) => String(v).replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');
