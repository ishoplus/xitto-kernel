// 共用 web 工具（web_search / web_fetch / http）— general 與 deep-research pack 共用。
const txt = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] });
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const stripTags = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

export function createWebFetchTool() {
  return {
    name: 'web_fetch', label: '抓網頁', readOnly: true,
    description: '抓取一個 URL 的內容並回傳純文字（HTML 去標籤、截斷）。讀某頁全文用。',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    execute: async (_id, { url }) => {
      try {
        const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        return txt({ url, status: res.status, text: text || '(空)' });
      } catch (e) { return txt({ error: e?.message || String(e), url }); }
    },
  };
}

export function createWebSearchTool() {
  return {
    name: 'web_search', label: '網路搜尋', readOnly: true,
    description: '用關鍵字搜尋網路，回傳前幾筆結果（標題 + URL + 摘要）。先 search 找來源，再用 web_fetch 讀全文。',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute: async (_id, { query }) => {
      try {
        const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
        const html = await res.text();
        const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
        const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
        const decode = (href) => { const u = /uddg=([^&]+)/.exec(href); return u ? decodeURIComponent(u[1]) : href; };
        const results = links.slice(0, 6).map((m, i) => ({ title: stripTags(m[2]), url: decode(m[1]), snippet: snippets[i] || '' }));
        return txt({ query, count: results.length, results });
      } catch (e) { return txt({ error: e?.message || String(e), query }); }
    },
  };
}

export function createHttpTool() {
  return {
    name: 'http', label: 'HTTP 請求',
    description: '發 HTTP 請求串接 API：method（預設 GET）、headers、body。回 status + headers + body（截斷）。',
    parameters: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } }, required: ['url'] },
    execute: async (_id, { url, method = 'GET', headers, body }) => {
      try {
        const m = String(method).toUpperCase();
        const res = await fetch(url, { method: m, headers: headers || {}, body: (m === 'GET' || m === 'HEAD') ? undefined : body, signal: AbortSignal.timeout(20000) });
        const text = (await res.text()).slice(0, 8000);
        return txt({ url, method: m, status: res.status, headers: Object.fromEntries(res.headers), body: text });
      } catch (e) { return txt({ error: e?.message || String(e), url }); }
    },
  };
}
