// 輕量串流 markdown 渲染器（零依賴，逐行）。delta 進 buffer，遇換行就把整行套 ANSI 樣式輸出；
// 末尾未完成的行在 flush 時輸出。支援：標題、code block(```)、inline code(`)、粗體(**)。
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m' };

const inline = (s) => s
  .replace(/\*\*([^*]+)\*\*/g, (_, t) => C.bold + t + C.reset)
  .replace(/`([^`]+)`/g, (_, t) => C.cyan + t + C.reset);

/**
 * @param {(s: string) => void} out
 */
export function createStreamRenderer(out) {
  let buf = '';
  let inCode = false;
  let firstDone = false;

  const prefix = () => { if (!firstDone) { firstDone = true; return C.green + '● ' + C.reset; } return ''; };

  const renderLine = (line) => {
    if (/^\s*```/.test(line)) { inCode = !inCode; out(prefix() + C.dim + line + C.reset + '\n'); return; }
    if (inCode) { out(prefix() + C.cyan + line + C.reset + '\n'); return; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { out(prefix() + C.bold + h[2] + C.reset + '\n'); return; }
    out(prefix() + inline(line) + '\n');
  };

  return {
    push: (delta) => {
      buf += delta;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { renderLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    },
    flush: () => { if (buf) { renderLine(buf); buf = ''; } firstDone = false; inCode = false; },
    active: () => firstDone || buf.length > 0,
  };
}
