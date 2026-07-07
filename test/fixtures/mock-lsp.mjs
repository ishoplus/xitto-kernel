// 測試用 mock LSP server：講 LSP 線協議，回 initialize、對 didOpen 推一筆診斷。
// 用來端到端測 lsp.js 的 client/高階流程，不需真的裝 language server。
import { encodeMessage, createDecoder } from '../../src/packs/shared/lsp.js';

const dec = createDecoder();
process.stdin.on('data', (chunk) => {
  for (const msg of dec.push(chunk)) {
    if (msg.method === 'initialize') {
      process.stdout.write(encodeMessage({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
    } else if (msg.method === 'textDocument/didOpen') {
      const uri = msg.params.textDocument.uri;
      process.stdout.write(encodeMessage({
        jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
        params: { uri, diagnostics: [
          { range: { start: { line: 2, character: 5 }, end: { line: 2, character: 8 } }, severity: 1, message: 'mock: undefined symbol', source: 'mock' },
          { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } }, severity: 2, message: 'mock: unused variable', source: 'mock' },
        ] },
      }));
    } else if (msg.method === 'exit') {
      process.exit(0);
    }
  }
});
