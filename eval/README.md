# eval — xitto-kernel 評估 harness

兩套評分（本目錄不進 npm 發佈包）：

- **code agent**（SWE-bench 風格）：`npm run eval` —— 建 repo → 確認修復前測試失敗 → agent 產 patch → 跑隱藏測試判定 resolved。
- **通用 agent**（GAIA 風格）：`node eval/general-run.js` —— 給目標 → agent 用工具完成 → 檢查**最終答案**（expect 正規化比對）或**結果狀態**（verify shell 檢查）。各題鍛鍊不同工具（bash / 檔案 / http / web_search）。

---

## code agent（SWE-bench 風格）

評估 coding pack：**建 repo → 確認修復前測試失敗 → agent 只看 problem 產 patch → 跑隱藏測試判定 resolved**。

## 跑迷你版（自足、即可跑）

```bash
node eval/run.js      # 需 ~/.xitto-code/providers.json
```

`eval/tasks.js` 是幾道自足任務（純 `node --test`、零外部依賴、不需 Docker）。
每題流程與 SWE-bench 一致：

1. 建一個 git repo（base commit），含一個 bug/未實作 + **隱藏測試**。
2. 確認修復前測試**失敗**（= SWE-bench 的 `FAIL_TO_PASS` 起點）。
3. 跑 `kernel.runGoal(problem)`（coding pack）—— **agent 只看 problem、看不到測試**。
4. `git diff` 取 patch，跑隱藏測試 → 通過即 **resolved**。

輸出 scoreboard：resolved 率、token 用量、回合數。

## 量了什麼

- **resolved**：隱藏測試 fail→pass（核心正確性，pass@1）
- **tokens / 題**：成本指標
- **rounds / 題**：goal loop 跑幾輪達成
- patch 內容（harness 回傳，可檢視 diff 品質）

## 接真實 SWE-bench Verified

`harness.js` 的 `runTask` 形狀不變，只要換掉「任務來源」與「環境/測試執行」：

1. **任務來源**：載入 `princeton-nlp/SWE-bench_Verified`（HuggingFace）的 instances，
   每題有 `repo`、`base_commit`、`problem_statement`、`test_patch`、`FAIL_TO_PASS`、`PASS_TO_PASS`。
2. **環境**：用 SWE-bench 官方**每題 Docker 映像**（各 repo 的 Python 依賴差異大，必須隔離環境）。
   把 repo checkout 到 `base_commit`，agent 在容器內的工作目錄產 patch。
3. **判定**：套上 `test_patch`（隱藏測試），跑 `FAIL_TO_PASS` 應全過、`PASS_TO_PASS` 應仍過 → resolved。
4. **接線點**：把 `runTask` 裡「建 repo / 跑 verify」換成「Docker checkout / 套 test_patch / 跑指定測試」，
   `createKernel(createCodingPack({cwd}), …) + runGoal(problem_statement)` 那段照舊。

### 完整步驟（真實 SWE-bench Verified）

需求：一台有 **Docker** 的機器、Python、足夠磁碟（映像大）、有預算的 API key、時間（建議先跑 20–50 題子集）。

```bash
# 1) 匯出 Verified 資料集成逐行 JSON（一次）
pip install datasets
python -c "from datasets import load_dataset; \
  [print(__import__('json').dumps(dict(x))) for x in load_dataset('princeton-nlp/SWE-bench_Verified', split='test')]" \
  > verified.jsonl

# 2) 用 xitto-kernel 產 patch（這側）—— clone repo@base_commit、跑 coding pack、git diff
node eval/swebench-generate.js --instances verified.jsonl --limit 20 --out predictions.jsonl

# 3) 官方 harness 跑隱藏測試評估（Docker，套 test_patch + FAIL_TO_PASS/PASS_TO_PASS）
pip install swebench
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path predictions.jsonl --max_workers 4 --run_id xitto1
# → 產出 resolved 報告（resolved 數 / 總數）
```

`swebench-generate.js` 的 `model_name_or_path` 設成 `xitto-kernel`；要換模型比較，改 `providers.json` 的 `defaultModel`。

> 公平比較提醒：code agent 成績 = scaffold（工具設計）+ 模型。要比「工具 vs Claude Code/Codex」，
> 用**同一底層模型**跑同一子集；否則比的是「工具+模型」綁一起。建議先跑 50 題 Verified 子集，
> 記錄 pass@1 + 成本 + 回合，再對照各家官方數字。

## 注意

- 迷你版任務無外部依賴，故 `sandbox` 預設關（避免環境摩擦）；可在 `runTask` opts 開 `sandbox:true`。
- 成本欄看 token；要顯示金額，在 `providers.json` 的 model 加 `cost`（每百萬 token 美元）。
