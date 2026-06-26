# 06 · 怎麼用底座做一個新領域 agent

一句話：**寫一個 DomainPack（最少 3 欄）→ 註冊到 CLI → 跑**。kernel 與其他 pack 零改動。

## 最小可跑（3 個必填欄位）

```js
// src/packs/hello/index.js
export function createHelloPack() {
  return {
    name: 'hello',
    systemPrompt: '你是友善的助手，用繁體中文回答。',
    tools: () => [{
      name: 'now', label: '時間', description: '回傳目前時間', readOnly: true,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: new Date().toISOString() }] }),
    }],
  };
}
```

這樣就是一個能跑的 agent 了。`createKernel(createHelloPack(), { model, getApiKey })` → `runTurn(...)`。

## 工具長什麼樣（kernel 的唯一要求）

kernel 不在乎工具做什麼，只要這個形狀（**metadata 決定安全行為**）：

```js
{
  name: 'do_thing',
  label: '顯示名',
  description: '給模型看的用途說明（寫清楚，模型靠它決定何時呼叫）',
  parameters: { /* JSON Schema */ },
  execute: async (id, params, signal, onUpdate, services) => ({ content: [{ type: 'text', text: '...' }] }),

  // ── metadata：決定 kernel 怎麼對待它 ──
  readOnly: true,      // 唯讀 → 守衛鏈自動放行、不問權限
  mutating: true,      // 會改動 → 計劃模式擋它、自動算進 mutatingTools
  sandboxable: true,   // 走 shell → 沙箱開時自動包進 Seatbelt（只對有 params.command 的工具有意義）
}
```

## 六個選填插槽（要更像「專業 agent」時才填）

| 插槽 | 用途 | 範例 |
|------|------|------|
| `contextFiles` | 啟動載入的領域規範檔 | `['NOTES.md']` |
| `mutatingTools` | 顯式指定哪些算改動（不給就從 `tool.mutating` 推） | `['add_note']` |
| `verify` | 每輪收尾自我驗收 | 連結檢查 / 測試 |
| `preToolPolicy` | 工具前領域守衛（守衛鏈第 3 格） | 「add 前必先 search」 |
| `permissionPolicy` | 沙箱/deny 預設 | `{ deny: ['bash:DROP'] }` |
| `memoryGuide` | 何時主動存記憶的提示 | 領域特化提示 |

> `preToolPolicy` 是領域「規矩」的所在：編碼是 read-before-edit、資料是 schema-before-query、
> 筆記是 search-before-add ——**同一個插槽，不同領域填不同規矩**。

## 三步驟：從零到能用

### 1) 寫 pack
`src/packs/<你的領域>/index.js`，export 一個 `create<Name>Pack({ cwd })`。

### 2) 註冊到 CLI
`src/app/main.js` 的 `PACKS` 加一行：
```js
import { createNotesPack } from '../packs/notes/index.js';
const PACKS = { coding: createCodingPack, 'data-query': createDataQueryPack, notes: createNotesPack };
```

### 3) 跑
```bash
npm start -- --pack notes              # 互動 CLI
npm start -- --pack notes --sandbox    # 要沙箱就加 --sandbox
```

## 該把什麼放進工具 vs prompt？

- **工具** = agent 能對世界做的動作（查 DB、發 API、寫檔、跑命令）。要副作用或要拿外部資料 → 工具。
- **systemPrompt** = 行為準則、口吻、流程規矩、何時用哪個工具。純推理/格式 → prompt。
- **preToolPolicy** = 硬性前置條件（程式擋，不靠模型自律）。「沒做 X 不准做 Y」→ 守衛。

## 不用碰的東西（kernel 免費給你）

接上任何 pack，自動獲得：多步工具循環、串流、權限/沙箱（含 Seatbelt）、危險命令偵測、
mutatingTools 推導、計劃模式、Ctrl+C 中斷、多輪歷史、CLI。**領域作者只寫「會什麼、守什麼」。**

完整範例見 `src/packs/notes/`（知識庫 agent），對照 `coding` / `data-query`。
