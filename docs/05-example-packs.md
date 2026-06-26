# 05 · 範例 Pack（驗證同介面能跑不同領域）

不同 pack 用**同一個介面**填不同領域，證明 kernel 不需為任何領域改動。
> 已實作可跑的 pack 在 [`src/packs/`](../src/packs/)：**coding**、**data-query**、**notes**（見下 A、B 與 [docs/06](06-authoring-a-pack.md)）。
> 本文另含一個 **ops / 客服** 領域作為「介面能延伸到哪」的示意（未內建，純說明）。
> 重點都一樣：同樣六個插槽，內容換了，kernel 沒換。

## A. coding pack（參考實作 == 現在的 xitto-code）

```js
export const codingPack = {
  name: 'coding',
  tools: () => [...createCodingTools(cwd), grep, find, ls, glob, readImage, ...bgTools],
  systemPrompt: '你是嚴謹的編碼 agent…（行為準則）',
  contextFiles: ['CLAUDE.md', 'AGENTS.md', 'XITTO.md', '.xitto-code.md'],
  // mutatingTools 省略 → 從工具 metadata 自動推導（write/edit/bash）
  verify: {
    shouldRun: (ctx) => ctx.turnModified,
    run: async () => runShell(detectVerifyCmd(cwd)),   // tsc / eslint
    maxRounds: 2,
  },
  preToolPolicy: {
    check: (ctx) => {                                  // read-before-edit
      if ((ctx.name === 'edit' || ctx.name === 'write') && exists(ctx.path) && !read.has(ctx.path))
        return { block: true, reason: `請先 read ${ctx.path} 再編輯` };
    },
  },
  permissionPolicy: { sandbox: { enabled: false }, defaultMode: 'default' },
};
```

## B. data-query pack（資料查詢 / 分析）

```js
export const dataQueryPack = {
  name: 'data-query',
  tools: () => [sqlQuery, listTables, describeTable, chartRender, exportCsv],
  systemPrompt: '你是資料分析 agent。先看 schema 再查；破壞性 SQL 一律先確認…',
  contextFiles: ['SCHEMA.md', 'METRICS.md'],          // 專案的表結構/指標定義
  mutatingTools: ['sqlExec'],                          // 只有寫入型 SQL 算 mutating；查詢唯讀
  // verify 省略 → 查詢沒有「自我驗收」概念
  preToolPolicy: {
    check: (ctx) => {                                  // schema-before-query（對照 read-before-edit）
      if (ctx.name === 'sqlQuery' && !ctx.session.schemaLoaded)
        return { block: true, reason: '請先用 listTables/describeTable 了解結構再下查詢' };
    },
  },
  permissionPolicy: { deny: ['bash:DROP', 'bash:TRUNCATE'], defaultMode: 'default' },
};
```

對照：`schema-before-query` 之於資料查詢，正如 `read-before-edit` 之於編碼——**同一個 preToolPolicy 插槽**。

## C. ops / customer-support pack（維運 / 客服工單）— 示意（未內建）

> 這個沒有內建實作，純粹展示「同介面能延伸到動錢/對外的高風險領域」。
> 實際內建的第三個 pack 是 **notes**（知識庫），見 [docs/06](06-authoring-a-pack.md) 與 `src/packs/notes/`。

```js
export const opsPack = {
  name: 'ops',
  tools: () => [searchTickets, getOrder, issueRefund, postReply, runRunbook],
  systemPrompt: '你是客服維運 agent。退款前必須先查到訂單；對外回覆前先給人審核…',
  contextFiles: ['RUNBOOK.md', 'POLICY.md'],
  mutatingTools: ['issueRefund', 'postReply'],         // 對外/動錢的算 mutating
  preToolPolicy: {
    check: (ctx) => {                                  // 退款前須先查到訂單
      if (ctx.name === 'issueRefund' && !ctx.session.orderVerified)
        return { block: true, reason: '退款前請先用 getOrder 確認訂單存在與金額' };
    },
  },
  permissionPolicy: { defaultMode: 'default' },        // issueRefund/postReply 非唯讀 → 一律走確認
};
```

## 同介面對照表

| 插槽 | coding | data-query | ops |
|------|------|------|------|
| `tools` | read/write/edit/bash | sql/chart/export | tickets/order/refund |
| `systemPrompt` | 編碼準則 | 分析準則 | 客服準則 |
| `contextFiles` | CLAUDE.md | SCHEMA.md | RUNBOOK.md |
| `mutatingTools` | write/edit/bash | sqlExec | refund/reply |
| `verify` | lint/型別 | —（無）| —（或 SLA 檢查）|
| `preToolPolicy` | read-before-edit | schema-before-query | order-before-refund |
| `permissionPolicy` | 沙箱可選 | deny 破壞性 SQL | 對外動作走確認 |

> **三個領域、同六個插槽、kernel 一行未改。** 這張表就是「xitto-code 能否當底座」的答案：
> 能——因為領域差異恰好能被這組插槽吸收，沒有任何一格需要 kernel 認識具體領域。

## 反例：什麼情況代表「抽象失敗」

若某個新領域需要 kernel **本身**改動才能支援（例如改 agent loop、改權限鏈順序、在 kernel 裡寫 `if (domain === 'x')`），
就代表有領域知識洩漏進 kernel，該把那塊再抽成新的 pack 插槽或 KernelServices 能力。
**判準：新領域 = 只新增一個 pack 檔，kernel/其他 pack 零改動。**
