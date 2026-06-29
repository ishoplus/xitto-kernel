// 跨平台啟動「本地許願台」（Windows / macOS / Linux 通用）。
// 取代 serve:local 原本的 Unix-only shell 語法（VAR=value cmd、${VAR:-default}）。
// 設好本地模式預設值後呼叫 startServer()——LOCAL 強制開，SANDBOX/TOKEN 未設才給預設（可被環境變數覆寫）。
process.env.XITTO_SERVER_LOCAL = '1';
if (!process.env.XITTO_SERVER_SANDBOX) process.env.XITTO_SERVER_SANDBOX = 'off';
if (!process.env.XITTO_SERVER_TOKEN) process.env.XITTO_SERVER_TOKEN = 'secret';

const { startServer } = await import('../src/app/server.js');
startServer();
