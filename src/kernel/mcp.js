// MCP 工具接入 — kernel 內建。.xitto-kernel/<pack>/mcp.json 連 MCP server（stdio），
// 把 server 的工具以 mcp__<server>__<tool> 注入。連線失敗的 server 自動略過。
// 非同步（連線需 await），故由 app 層在啟動時載入後以 config.extraTools 傳入 createKernel。
import { existsSync, readFileSync } from 'node:fs';

const noop = { tools: [], close: async () => {} };

/**
 * @param {string} mcpConfigPath  .xitto-kernel/<pack>/mcp.json
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<{ tools: import('../types.js').Tool[], close: () => Promise<void> }>}
 */
export async function loadMcpTools(mcpConfigPath, onLog = () => {}) {
  if (!existsSync(mcpConfigPath)) return noop;
  let cfg;
  try { cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf8')); } catch { onLog('mcp.json 解析失敗，略過'); return noop; }
  const servers = cfg.mcpServers || {};
  if (!Object.keys(servers).length) return noop;

  let Client, StdioClientTransport;
  try {
    ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
    ({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
  } catch { onLog('未安裝 @modelcontextprotocol/sdk，略過 MCP'); return noop; }

  const clients = [];
  const tools = [];
  for (const [name, sc] of Object.entries(servers)) {
    if (!sc || typeof sc.command !== 'string') continue;
    try {
      const transport = new StdioClientTransport({ command: sc.command, args: sc.args || [], env: { ...process.env, ...(sc.env || {}) } });
      const client = new Client({ name: 'xitto-kernel', version: '0.0.1' }, { capabilities: {} });
      await client.connect(transport);
      const { tools: mcpTools } = await client.listTools();
      for (const t of mcpTools) {
        tools.push({
          name: `mcp__${name}__${t.name}`, label: `${name}:${t.name}`,
          mutating: true, // 外部工具保守視為有副作用：走權限確認、計劃模式擋下
          description: t.description || `MCP ${name} 的 ${t.name}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
          execute: async (_id, args) => {
            try {
              const r = await client.callTool({ name: t.name, arguments: args || {} });
              return { content: r.content || [{ type: 'text', text: JSON.stringify(r) }] };
            } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ error: e?.message || String(e) }) }] }; }
          },
        });
      }
      clients.push(client);
      onLog(`MCP ${name}：載入 ${mcpTools.length} 個工具`);
    } catch (e) { onLog(`MCP ${name} 連線失敗，略過：${e?.message || e}`); }
  }
  return { tools, close: async () => { for (const c of clients) { try { await c.close(); } catch { /* 略 */ } } } };
}
