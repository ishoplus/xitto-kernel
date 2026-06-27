// app 子路徑公開 API（xitto-kernel/app）：外部 agent 專案 import 這些來啟動，不需改 kernel。
export { runCli } from './cli.js';
export { createServerApp, startServer } from './server.js';
export { loadModel, loadProvidersConfig, buildModel } from './providers.js';
export { newAgent } from './scaffold.js';
export { main } from './main.js';
