# 09 · 批次可寫 map-verify（`xitto-kernel map`）

對一批項目各做一次「**可寫轉換 → 驗收 → 通過保留、未通過自動回滾**」。安全的「可信任 × 規模化的變更」——驗收 DoD 契約 ×（逐項）規模。

## 怎麼用

```bash
xitto-kernel map items.json [--pack <name>] [--cwd <dir>] [--sandbox] [--model <id>]
```

`items.json` 是非空 JSON 陣列，每項可為：

```json
[
  "一句任務字串",
  { "task": "重構 utils.js 並保持 API 不變", "verify": "npm test" }
]
```

- 字串項：用 pack 的 verify（若 pack 有）當驗收。
- `{ task, verify }`：用該 `verify` shell 指令當驗收（exit 0 = 通過）。

## 行為

逐項**序列**執行（避開平行寫衝突）：

```
for 每項：
  記 undo 標記 → 可寫回合（經守衛/沙箱/undo）→ 驗收
  通過 ✓ 保留 / 未通過 ✗ undo 回滾該項所有檔案改動
```

- **失敗自動復原**：未通過的項目，其檔案改動會被回滾，工作區保持乾淨。
- 逐項印 `✓ / ✗ 已回滾 / · 未驗`，結尾給 `passed/total`。
- 批次非互動 → 自動核准 mutating；**安全來自「驗收通過才保留、未通過回滾」**（可加 `--sandbox` 再關住命令）。

## 何時用

- 大規模重構 / 跨檔遷移 / 批次修復——每個檔獨立、各自可驗證。
- 比「一個大目標」更可控：每項各自驗收、各自成敗、失敗不污染。

## 限制

- 只回滾「帶 `path` 的檔案改動」（undo 快照範圍）；`bash` 等非檔案副作用不在回滾內。
- 序列執行（非平行）——換取零寫衝突與乾淨回滾；平行隔離（git worktree）為後續優化。

## 程式化使用（kernel API）

```js
import { createKernel } from 'xitto-kernel';
const k = createKernel(pack, { cwd, model, getApiKey });
const out = await k.mapVerify(
  [{ task: '把 a.js 轉成 TS', verify: 'tsc --noEmit a.ts' }, '整理 b.md 格式'],
  { onItem: (r) => console.log(r.ok ? '✓' : '✗', r.task) },
);
// out = { total, passed, failed, results: [{ task, ok, verified, rolledBack, verify, text }] }
```
