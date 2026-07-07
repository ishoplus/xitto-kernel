// 測試用 mock LSP server：講 LSP 線協議，回 initialize、對 didOpen 推一筆診斷。
// 用來端到端測 lsp.js 的 client/高階流程，不需真的裝 language server。
import { encodeMessage, createDecoder } from '../../src/packs/shared/lsp.js';

const dec = createDecoder();
const reply = (id, result) => process.stdout.write(encodeMessage({ jsonrpc: '2.0', id, result }));
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
    } else if (msg.method === 'textDocument/definition') {
      const uri = msg.params.textDocument.uri;
      reply(msg.id, [{ uri, range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } } }]);
    } else if (msg.method === 'textDocument/hover') {
      reply(msg.id, { contents: { kind: 'markdown', value: 'mock hover: function foo(): void' }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } });
    } else if (msg.method === 'textDocument/documentSymbol') {
      reply(msg.id, [{
        name: 'foo', kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
        children: [{ name: 'bar', kind: 13, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }],
      }]);
    } else if (msg.method === 'textDocument/references') {
      const uri = msg.params.textDocument.uri;
      reply(msg.id, [
        { uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } } },
        { uri, range: { start: { line: 4, character: 11 }, end: { line: 4, character: 14 } } },
      ]);
    } else if (msg.method === 'textDocument/rename') {
      const uri = msg.params.textDocument.uri;
      const nn = msg.params.newName;
      reply(msg.id, { changes: { [uri]: [
        { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: nn },
        { range: { start: { line: 4, character: 11 }, end: { line: 4, character: 14 } }, newText: nn },
      ] } });
    } else if (msg.method === 'exit') {
      process.exit(0);
    }
  }
});
