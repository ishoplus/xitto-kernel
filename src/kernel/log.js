// 模型介面日誌 + 自動重試 — kernel 對「怎麼觀測一次 LLM 呼叫」的落地。
//
// 為什麼需要：內網自建端點（qwen / deepseek / glm 相容端點）常出現「沒回覆就中斷」，
// 但 kernel 全程沒有請求/回應日誌，出錯時只留一句 error.message（相容端點常是空字串），無從排查。
// 這裡用 pi-ai 已暴露、但先前沒接的兩個鉤子把整條鏈路攤開：
//   onPayload(params, model)         → 送出前的「完整請求 body」
//   onResponse({status,headers})     → 模型端回的「HTTP 狀態碼 + headers」
// 再包住串流迭代器（首字延遲 / 事件時序 / 斷點）與 result()（stopReason / usage / 錯誤原文），
// 每次呼叫寫成一行 JSONL。關鍵是把結果分類成 outcome：
//   ok          正常有內容收尾
//   empty       串流結束、沒錯誤、但回應完全沒內容 ← 「沒回覆就中斷」的核心徵狀
//   interrupted 串流途中連線斷 / 迭代丟例外（未收到完整回應）
//   http-error  模型端回 4xx/5xx
//   aborted     使用者中止（Ctrl+C / abort signal）
//   error       串流回 stopReason=error 或其他例外
// 同時注入 maxRetries / timeoutMs（走 pi-ai → SDK 層），連線錯 / 429 / 5xx 自動重試，作為緩解。

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// 只精確比對「機密欄位鍵名」再遮罩——避免誤傷 max_tokens 之類含 token 字樣的正常欄位。
const SECRET_KEY = /^(authorization|x-api-key|api[-_]?key|apikey|cookie|set-cookie|proxy-authorization|secret|password)$/i;

function redactHeaders(h) {
  if (!h || typeof h !== 'object') return h;
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = SECRET_KEY.test(k) ? '***' : v;
  return out;
}

// 深層遮罩請求 body 內的機密欄位（實務上金鑰在 headers，body 幾乎不含；仍防呆）。
function redactBody(v, depth = 0) {
  if (v == null || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => redactBody(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '***' : redactBody(val, depth + 1);
    return out;
  }
  return v;
}

function summarizeUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const { input, output, cacheRead, cacheWrite, totalTokens } = u;
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

// 解析日誌等級：config.level > XITTO_LOG_LEVEL > (XITTO_LOG=off → off) > 預設 'full'。
function resolveLevel(opts) {
  if (opts.enabled === false) return 'off';
  const raw = String(opts.level || process.env.XITTO_LOG_LEVEL || (process.env.XITTO_LOG === 'off' ? 'off' : '') || 'full').toLowerCase();
  return raw === 'off' || raw === 'brief' || raw === 'full' ? raw : 'full';
}

const NULL_RECORD = {
  onPayload() {}, onHttp() {}, onEvent() {}, onStreamEnd() {}, onError() {}, onResult() {},
  markAborted() {}, finish() { return null; },
};

// 累積一次呼叫的所有觀測，在 finish() 時一次寫出一行 JSONL（便於 grep / jq 分析）。
class CallRecord {
  constructor(seq, meta, level, sink) {
    this.level = level; this.sink = sink; this.start = meta.now;
    this.firstTokenMs = null; this.events = {}; this.endedBy = null;
    this.done = false; this.httpError = false; this.aborted = false;
    this._contentEmpty = null; this._resultStop = null;
    this.rec = {
      ts: new Date(meta.now).toISOString(),
      callId: `c${seq}`,
      turnId: meta.turnId, // 與 agent-loop.jsonl 同一輪關聯（undefined = 非 runTurn 主鏈）
      label: meta.label || 'main',
      attempt: meta.attempt, attempts: meta.attempts,
      model: meta.model && { id: meta.model.id, api: meta.model.api, provider: meta.model.provider, baseUrl: meta.model.baseUrl },
      request: {
        messages: meta.messages, tools: meta.tools,
        systemChars: meta.systemChars, reasoning: meta.reasoning || undefined,
      },
    };
  }

  onPayload(params) {
    if (this.level === 'full') this.rec.request.body = redactBody(params);
    else this.rec.request.maxTokens = params?.max_tokens ?? params?.maxTokens; // brief 仍留 token 上限（常見肇因）
  }

  onHttp(info) {
    const status = info?.status;
    this.rec.http = { status };
    if (this.level === 'full') this.rec.http.headers = redactHeaders(info?.headers);
    if (typeof status === 'number' && status >= 400) this.httpError = true;
  }

  onEvent(ev) {
    const t = ev?.type; if (!t) return;
    this.events[t] = (this.events[t] || 0) + 1;
    if (t === 'done' || t === 'error') this.endedBy = t;
    if (this.firstTokenMs == null && /_delta$/.test(t)) this.firstTokenMs = meta_elapsed(this.start);
  }

  onStreamEnd(how) { if (!this.endedBy) this.endedBy = how; }
  markAborted() { this.aborted = true; }

  onError(err) {
    this.rec.error = {
      name: err?.name,
      message: err instanceof Error ? err.message : String(err),
      code: err?.code, status: err?.status,
      stack: this.level === 'full' && err?.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : undefined,
    };
  }

  onResult(final) {
    const content = final?.content || [];
    const textChars = content.filter((c) => c.type === 'text').reduce((n, c) => n + (c.text?.length || 0), 0);
    const thinkingChars = content.filter((c) => c.type === 'thinking').reduce((n, c) => n + (c.thinking?.length || 0), 0);
    const toolCalls = content.filter((c) => c.type === 'toolCall').length;
    this.rec.result = {
      stopReason: final?.stopReason, usage: summarizeUsage(final?.usage),
      textChars, thinkingChars, toolCalls,
      errorMessage: final?.errorMessage || undefined,
    };
    this._contentEmpty = textChars === 0 && thinkingChars === 0 && toolCalls === 0;
    this._resultStop = final?.stopReason;
  }

  _classify() {
    if (this.aborted || this._resultStop === 'aborted') return 'aborted';
    if (this.rec.error) return this.httpError ? 'http-error' : 'interrupted';
    if (this.httpError) return 'http-error';
    if (this._resultStop === 'error') return 'error';
    if (this._contentEmpty === true) return 'empty';
    return 'ok';
  }

  finish(outcomeHint) {
    if (this.done) return this.rec; this.done = true;
    this.rec.timing = { firstTokenMs: this.firstTokenMs, durationMs: meta_elapsed(this.start) };
    this.rec.stream = { endedBy: this.endedBy, events: this.events };
    this.rec.outcome = outcomeHint || this._classify();
    this.sink(this.rec);
    return this.rec;
  }
}

// 抽出來便於在無 performance 環境下退回 Date；start 是 ms 時戳。
function meta_elapsed(startMs) { return Date.now() - startMs; }

// 建立日誌器：回傳 { level, dir, file, begin(meta), loop(rec) }。level='off' 時零開銷。
// 兩個檔：model-calls.jsonl（每次 LLM 呼叫）＋ agent-loop.jsonl（工具/回合/收尾事件），以 turnId 關聯。
export function createModelLogger(opts = {}) {
  const level = resolveLevel(opts);
  const dir = opts.dir || process.env.XITTO_LOG_DIR || join(opts.dataDir || '.', 'logs');
  const file = join(dir, 'model-calls.jsonl');
  const toStderr = level !== 'off' && process.env.XITTO_LOG_STDERR !== '0';
  let seq = 0; let ready = false;

  const append = (basename, rec) => {
    if (level === 'off') return;
    if (!ready) { try { mkdirSync(dir, { recursive: true }); } catch { /* 無法建目錄則放棄寫檔 */ } ready = true; }
    try { appendFileSync(join(dir, basename), JSON.stringify(rec) + '\n'); } catch { /* 寫檔失敗不阻斷主流程 */ }
  };

  const sink = (rec) => {
    append('model-calls.jsonl', rec);
    // 非 ok 結果額外在 stderr 印一行——讓「沒回覆就中斷」不再無聲無息。
    if (toStderr && rec.outcome && rec.outcome !== 'ok') {
      const m = rec.model?.id || '?';
      const err = rec.error?.message || rec.result?.errorMessage || '';
      try { process.stderr.write(`[xitto][llm] ${rec.callId} ${rec.label} ${m} → ${rec.outcome} ${rec.timing?.durationMs}ms ${err}\n`); } catch { /* 略 */ }
    }
  };

  return {
    level, dir, file,
    begin(meta) {
      if (level === 'off') return NULL_RECORD;
      return new CallRecord(++seq, { ...meta, now: Date.now() }, level, sink);
    },
    // agent-loop 事件（工具呼叫/回合收尾/中止）。由 attachLoopLogger 呼叫。
    loop(rec) { if (level !== 'off') append('agent-loop.jsonl', { ts: new Date().toISOString(), ...rec }); },
  };
}

// 訂閱 Agent 事件，把 agent-loop 過程寫進 agent-loop.jsonl：
//   tool       每個工具呼叫的結果（tool/isError/durationMs/resultChars；full 等級含 args 與錯誤原文）
//              —— 守衛攔截會以 isError=true 出現在這裡，故「被守衛擋掉」也看得到。
//   turn_end   每個回合收尾（stopReason/errorMessage）—— handleRunFailure 的 error/aborted 收尾在此現形。
//   agent_end  整輪結束。
// 回傳 unsubscribe。listener 內任何錯誤都吞掉，絕不影響主流程。
export function attachLoopLogger(agent, logger, meta = {}) {
  if (!logger || logger.level === 'off' || typeof agent?.subscribe !== 'function') return () => {};
  const turnId = meta.turnId;
  const full = logger.level === 'full';
  const starts = new Map();
  const trunc = (v, n = 600) => {
    try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; } catch { return undefined; }
  };
  const clen = (content) => (Array.isArray(content) ? content.reduce((n, c) => n + (c?.text?.length || 0), 0) : 0);
  return agent.subscribe((e) => {
    try {
      switch (e?.type) {
        case 'tool_execution_start':
          starts.set(e.toolCallId, Date.now());
          break;
        case 'tool_execution_end': {
          const t0 = starts.get(e.toolCallId); starts.delete(e.toolCallId);
          logger.loop({
            turnId, kind: 'tool', tool: e.toolName, isError: !!e.isError,
            durationMs: t0 != null ? Date.now() - t0 : null,
            resultChars: clen(e.result?.content),
            args: full ? trunc(e.args) : undefined,
            error: e.isError ? trunc((e.result?.content || []).map((c) => c?.text).filter(Boolean).join(' ')) : undefined,
          });
          break;
        }
        case 'turn_end':
          logger.loop({ turnId, kind: 'turn_end', stopReason: e.message?.stopReason, errorMessage: e.message?.errorMessage, toolResults: e.toolResults?.length });
          break;
        case 'agent_end':
          logger.loop({ turnId, kind: 'agent_end', messages: e.messages?.length });
          break;
        default: break;
      }
    } catch { /* 日誌 listener 不得影響主流程 */ }
  });
}

// 判斷是否應重試（僅在 streamFn 尚未回傳就丟出時）：連線類 / 逾時 / 5xx / 429。
function retriable(err) {
  const status = err?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  const code = String(err?.code || '');
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR|ABORT_ERR/i.test(code)
    || /socket hang up|network|timeout|fetch failed/i.test(err?.message || '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 包住 response（async-iterable + result()），把串流事件與最終結果餵給 record。
// 只依賴 caller 用到的兩個介面：for-await 迭代 與 result()。
function wrapResponse(response, rec, signal) {
  let finished = false;
  const iter = response[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          try {
            const r = await iter.next();
            if (r.done) rec.onStreamEnd('natural'); else rec.onEvent(r.value);
            return r;
          } catch (err) {
            if (signal?.aborted) rec.markAborted();
            rec.onStreamEnd(signal?.aborted ? 'abort' : 'error');
            rec.onError(err); rec.finish(); finished = true;
            throw err;
          }
        },
        return(v) { return iter.return ? iter.return(v) : Promise.resolve({ done: true, value: v }); },
      };
    },
    async result() {
      try {
        const final = await response.result();
        rec.onResult(final);
        if (!finished) { rec.finish(); finished = true; }
        return final;
      } catch (err) {
        if (!finished) {
          if (signal?.aborted) rec.markAborted();
          rec.onError(err); rec.finish(); finished = true;
        }
        throw err;
      }
    },
  };
}

/**
 * 包裝一個 streamFn，加上「完整診斷日誌 + 自動重試」。
 * @param {Function} streamFn  原始 streamFn(model, ctx, opts) → response
 * @param {object}   logger    createModelLogger() 的結果
 * @param {{ maxRetries?: number, timeoutMs?: number, backoffMs?: number, label?: string }} [cfg]
 * @returns {Function} 同介面的 streamFn
 */
export function withLogging(streamFn, logger, cfg = {}) {
  const label = cfg.label || 'main';
  const turnId = cfg.turnId;
  const maxRetries = cfg.maxRetries;
  const timeoutMs = cfg.timeoutMs;
  const backoffMs = cfg.backoffMs ?? 500;

  return async function loggedStreamFn(model, ctx, opts = {}) {
    const attempts = (maxRetries ?? 0) + 1;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const rec = logger.begin({
        label, turnId, attempt, attempts, model,
        messages: ctx?.messages?.length, tools: ctx?.tools?.length,
        systemChars: ctx?.systemPrompt?.length, reasoning: opts.reasoning,
      });
      const chained = {
        ...opts,
        // SDK 層重試/逾時：連線錯、429、5xx 由底層 fetch 重試（未污染 caller 訊息，最穩妥的緩解）。
        ...(maxRetries != null ? { maxRetries: opts.maxRetries ?? maxRetries } : {}),
        ...(timeoutMs != null ? { timeoutMs: opts.timeoutMs ?? timeoutMs } : {}),
        onPayload: async (p, m) => { rec.onPayload(p); return opts.onPayload ? opts.onPayload(p, m) : undefined; },
        onResponse: async (i, m) => { rec.onHttp(i); return opts.onResponse ? opts.onResponse(i, m) : undefined; },
      };
      try {
        const response = await streamFn(model, ctx, chained);
        return wrapResponse(response, rec, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) rec.markAborted();
        rec.onError(err); rec.finish();
        lastErr = err;
        // 只有「連 response 都沒拿到就丟例外」才在包裝層重試——此時尚未污染 caller 的訊息串。
        if (attempt < attempts && retriable(err) && !opts.signal?.aborted) { await sleep(backoffMs * attempt); continue; }
        throw err;
      }
    }
    throw lastErr;
  };
}

// 從 config/env 解析重試設定（給 index.js 用）。
export function resolveRetry(cfg = {}) {
  const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    maxRetries: num(cfg.maxRetries ?? process.env.XITTO_LLM_RETRIES, 1),
    timeoutMs: num(cfg.timeoutMs ?? process.env.XITTO_LLM_TIMEOUT_MS, undefined),
    backoffMs: num(cfg.backoffMs ?? process.env.XITTO_LLM_BACKOFF_MS, 500),
  };
}
