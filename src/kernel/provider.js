// Provider 呼叫適配 — kernel 怎麼正確地調用 LLM provider（與「provider 設定」不同，後者屬 app）。
// 預設 streamFn 包 pi-ai 的 streamSimple，並處理 anthropic 相容端點的 prompt caching 相容性。
import { streamSimple } from '@mariozechner/pi-ai';

// 該 model 是否該關掉 prompt caching：'none' = 關閉。
// pi-ai 對所有 anthropic-messages provider 預設加 cache_control，但只有「真正的 Anthropic」端點支援；
// MiniMax 等 anthropic 相容端點會因此回 500，需關閉。（沿用 xitto-code config.cacheRetentionFor）
export function cacheRetentionFor(model) {
  if (!model) return undefined;
  if (model.cache === false) return 'none';
  if (model.cache === true) return undefined;
  if (model.api !== 'anthropic-messages') return undefined;
  return /(^|\/\/|\.)anthropic\.com/.test(model.baseUrl || '') ? undefined : 'none';
}

// 預設 streamFn：Agent loop 用它串流一次 assistant 回應。
export function defaultStreamFn() {
  return (model, ctx, opts) =>
    streamSimple(model, ctx, { ...opts, cacheRetention: cacheRetentionFor(model) || opts.cacheRetention });
}
