// App 層：從 providers.json 載入並組裝 model（沿用 xitto providers.json 格式）。
// 這是「provider 設定」，屬 app；kernel 本身 provider 無關（只收 model + getApiKey）。
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PATH = () => process.env.XITTO_CODE_CONFIG || join(homedir(), '.xitto-code', 'providers.json');

export function loadProvidersConfig(path = DEFAULT_PATH()) {
  if (!existsSync(path)) { const err = new Error(`找不到 providers.json：${path}`); err.noConfig = true; throw err; }
  return { ...JSON.parse(readFileSync(path, 'utf8')), path };
}

// 從設定建 resolver：resolveModel(id)→model|null（跨 provider 查找）；getApiKey(provider)→key（provider-aware）。
// 給 per-agent model（delegate 指定不同 model，可能不同 provider，需對應的 apiKey）。
export function buildResolver(cfg) {
  const providers = cfg.providers || {};
  const getApiKey = (provider) => resolveEnv((providers[provider]?.apiKey) || '');
  const resolveModel = (id) => {
    if (!id) return null;
    for (const [provider, pcfg] of Object.entries(providers)) {
      const m = (pcfg.models || []).find((x) => x.id === id);
      if (!m) continue;
      return {
        id: m.id, name: m.name || m.id, provider,
        api: pcfg.api || 'openai-completions', baseUrl: pcfg.baseUrl,
        reasoning: m.reasoning || false, input: m.input || ['text'], output: m.output || ['text'],
        cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow || 32000, maxTokens: m.maxTokens || 4096,
        cache: m.cache ?? pcfg.cache,
      };
    }
    return null;
  };
  return { resolveModel, getApiKey };
}

export function buildModel(cfg, modelId) {
  const { resolveModel, getApiKey } = buildResolver(cfg);
  const targetId = modelId || cfg.defaultModel;
  const model = resolveModel(targetId);
  if (!model) throw new Error(`providers.json 找不到 model「${targetId}」`);
  // getApiKey 預設用主 model 的 provider；但接受 provider 參數（per-agent 跨 provider model 用）。
  return { model, resolveModel, getApiKey: (provider) => getApiKey(provider || model.provider) };
}

// 一步到位：載入設定 + 組裝指定（或預設）model（回傳含 resolveModel，供 per-agent model）
export function loadModel(modelId, path) {
  return buildModel(loadProvidersConfig(path), modelId);
}

const resolveEnv = (v) => String(v).replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');
