# 07 · 自訂 agent 類型（對標 Claude Code subagents）

把子 agent 從「一個寫死的唯讀調查員」變成**具名、專長化、可組合**的類型——主 agent 依描述委派給對的子 agent，主對話保持乾淨。

## 放哪裡

每個工作目錄、每個 pack 各自一組（綁 cwd → 天然只用這個專案的類型）：

```
<cwd>/.xitto-kernel/<pack>/agents/*.md      # 例：.xitto-kernel/coding/agents/reviewer.md
```

一個 `.md` 一個類型。啟動時載入，類型清單會注入系統提示，主 agent 依 `description` 決定何時委派。

## 檔案格式

YAML frontmatter + 內文（內文＝該類型的 system prompt）：

| 欄位 | 必填 | 說明 |
|---|---|---|
| `name` | 是 | 類型名（會 slug 化）；委派時用它指定 |
| `description` | 建議 | **何時用**——主 agent 讀這句決定要不要委派給它 |
| `tools` | 否 | 工具白名單（逗號分隔）；省略＝給全部（唯讀委派則全部唯讀工具） |
| `model` | 否 | 指定 model id（per-agent model；需 app 有提供 provider 設定，CLI/serve 已支援） |
| 內文 | 是 | 該類型的 system prompt |

## 怎麼被呼叫

| 工具 | 能力 | 用途 |
|---|---|---|
| `spawn_agent` `{ task, agentType }` | **唯讀**（讀檔/搜尋/分析）| 委派一個聚焦調查 |
| `spawn_agents` `{ tasks[], agentType }` | **唯讀、平行** | 對很多項目同時各派一個（量大時） |
| `delegate` `{ agentType, task }` | **可寫**（能改檔/跑命令，全程經守衛/沙箱/undo）| 把獨立子任務交給專長子 agent 去「做」 |

- `agentType` 省略 → 用預設唯讀調查員。
- 唯讀（spawn_*）只拿唯讀工具的子集；可寫（delegate）的工具白名單可含 `write`/`edit`/`bash`，但仍逐一過守衛。
- **防遞迴**：被委派的子 agent 不能再 `delegate`/`spawn`（單層深度）。

## 範本（可直接複製）

### 唯讀：程式碼審查員

`.xitto-kernel/coding/agents/reviewer.md`

```markdown
---
name: reviewer
description: 審查程式碼變更，找 bug、風格與安全問題。需要專門 code review 時用。
tools: read, grep, glob, ls
---
你是嚴格的程式碼審查員，只讀不改。逐項列出問題，每項附：
- 檔案:行號
- 嚴重度（高/中/低）
- 具體問題與修正建議
不確定的地方標明，不臆測。最後給一句總評。
```

用：`spawn_agent({ agentType: "reviewer", task: "審查 src/api/ 的變更" })`

### 可寫：重構執行者

`.xitto-kernel/coding/agents/refactorer.md`

```markdown
---
name: refactorer
description: 依指示重構檔案並保持行為不變。需要實際改檔的聚焦子任務時用。
tools: read, edit, write, grep, glob, bash
---
你是重構執行者。依指示精準修改檔案，保持對外行為與 API 不變。
準則：改前先 read；小步前進；改完跑相關測試確認沒壞；只動被交辦的範圍。
```

用：`delegate({ agentType: "refactorer", task: "把 utils.js 的 callback 改成 async/await，保持 API" })`

### 用便宜模型的調查員（per-agent model）

```markdown
---
name: scout
description: 大量、淺層的查找；用便宜模型跑雜活。
tools: read, grep, glob
model: <你 providers.json 裡某個便宜 model 的 id>
---
你是快速偵查員，只做淺層查找與彙整，回簡短結論。
```

用：`spawn_agents({ agentType: "scout", tasks: ["查 A 模組用途", "查 B 模組用途", ...] })`

## 小抄

- 新增類型：在 `.xitto-kernel/<pack>/agents/` 丟一個 `.md`，重啟即載入（agent 也能自己用 `write` 建）。
- `description` 寫清楚「**做什麼＋何時用**」——這就是主 agent 的委派依據。
- 唯讀調查用 `spawn_agent`/`spawn_agents`；要動手改檔用 `delegate`。
- `tools` 白名單越小越安全；可寫類型才放 `write`/`edit`/`bash`。
