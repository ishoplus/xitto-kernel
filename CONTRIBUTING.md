# Contributing

歡迎貢獻！xitto-kernel 是領域無關的 agent 底座。

## 開發

```bash
npm install
npm test          # 全部測試（macOS 會跑真實 Seatbelt 隔離測試；其他平台自動 skip）
npm run demo      # 不靠 LLM 的架構示範
```

## 原則

- **kernel 必須領域無關**：`src/kernel/` 不可出現任何具體領域的工具名（如寫死 `'edit'`/`'bash'`）。
  「唯讀 / 會改動 / 可沙箱」一律由工具自帶 metadata（`readOnly` / `mutating` / `sandboxable`）決定。
- **守衛鏈順序不可繞過**：pack 只能在第 3 格（`preToolPolicy`）插領域守衛，不能跳過權限/沙箱（第 5 格）。
- **領域邏輯放 pack，不放 kernel**：新領域 = 新增一個 `DomainPack`，kernel 零改動。
  判準：若某需求要改 kernel 才能支援，代表有領域知識洩漏，應抽成新的插槽或 `KernelServices` 能力。
- **新增工具請補 metadata**：`mutating` / `readOnly` / `sandboxable`，否則安全行為會錯。

## 提交

- 改動請附測試（`test/*.test.js`，用 `node --test`）。
- 動到守衛鏈 / sandbox / agent loop 時，務必確認測試全綠（CI 會在 ubuntu + macOS × node 20/22 跑）。
- commit message 用中文或英文皆可，講清楚「為什麼」。

## 架構文件

先讀 [`docs/01-architecture.md`](docs/01-architecture.md)，再看 [`docs/03-kernel-contract.md`](docs/03-kernel-contract.md)（不變式）。
做新領域 agent 看 [`docs/06-authoring-a-pack.md`](docs/06-authoring-a-pack.md)。
