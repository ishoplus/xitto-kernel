# xitto-kernel

**English** · [繁體中文](./README.zh-TW.md)

[![npm](https://img.shields.io/npm/v/xitto-kernel.svg)](https://www.npmjs.com/package/xitto-kernel)
[![CI](https://github.com/ishoplus/xitto-kernel/actions/workflows/ci.yml/badge.svg)](https://github.com/ishoplus/xitto-kernel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)

> A domain-agnostic agent foundation (**usable as a dependency** — your domain agent is a standalone project that imports the kernel rather than cloning it, so upgrades don't get frozen in).

Takes `xitto-code`, a complete coding agent, and abstracts it into a **domain-agnostic agent kernel** + pluggable **DomainPacks**.
The same kernel (multi-step tool loop, guard chain, permissions/sandbox, provider abstraction) can host an agent for any domain;
"coding" is just one DomainPack — swap it for "data query", "knowledge base", "support/ops", etc. by replacing the pack.
The interactive CLI lives in the app layer (thin); a richer TUI or other frontends can be another app consuming the same kernel events.

![xitto Wishboard — say what you want, watch it work, collect the deliverable](https://raw.githubusercontent.com/ishoplus/xitto-kernel/main/assets/wishboard.png)

> The 🪄 **Wishboard** web UI (one of the frontends): type one line → it runs in the background → you watch the live process (phase, steps, colored diffs) and collect the deliverable.

## In one line

> **The kernel provides "how to run an agent"; a DomainPack provides "what this agent can do, and what it guards."**

## Where the design comes from

After scanning xitto-code, roughly **80% was already a domain-agnostic kernel**; only three things were truly coupled to coding:
`read-before-edit`, `lint/type auto-verification`, and `git integration`. This design peels those three out of the kernel and into the pack's responsibilities.

## Quick start

**Prerequisite**: Node.js ≥ 20

**1. Install** (published on npm)
```bash
npm install -g xitto-kernel    # global command: xitto-kernel
```
> Developing this repo: `cd xitto-kernel && npm install && npm link`.

**2. First-time setup** (interactive guide, generates `~/.xitto-code/providers.json`)
```bash
xitto-kernel init
```
Walks you through picking a provider (MiniMax / Anthropic / OpenAI / DeepSeek / custom) → filling in the model →
setting the API key (recommended: reference an env var via `${NAME}` so the key never lands on disk). Existing xitto-code users can reuse their config and skip this step.
(Starting without config prompts you to run `init`; existing config is never overwritten — only `--force` merges in new providers.)

**3. Run a built-in pack (interactive CLI)**
```bash
xitto-kernel                  # coding agent (read/write files, run commands)
xitto-kernel --tui            # full Ink TUI (persistent status bar, streaming, Esc to interrupt, tool cards ⏺/⎿, colored diffs, todos ☑; needs a real terminal)
xitto-kernel --pack notes     # notes / knowledge-base agent
xitto-kernel --pack data-query
xitto-kernel --pack patent    # patent disclosure assistant (find inventions, draft the disclosure)
xitto-kernel --pack uiux      # UI/UX agent (accessible, responsive UI; a11y verify gate)
xitto-kernel --cwd ~/my-proj  # set the working directory (sandbox root; created if missing). default: current dir
xitto-kernel --sandbox        # open the Seatbelt sandbox on startup
```

**Inside the CLI**: just type what you want (the model calls tools itself); commands `/help` `/goal <goal>` `/sandbox` `/plan` `/undo` `/tools` `/trust` `/memory` `/sessions` `/resume` `/exit`; `Ctrl+C` interrupts the current turn, press again while idle to exit.

**Progressive trust (accumulates as you go)**: mutating/dangerous tools ask for confirmation before running; when you approve you can choose `[a]` to trust the whole tool, or `[c]` to trust only "this command-signature class" (e.g. `git status`, `npm test` — fine-grained; `npm install` still asks). Choices are **persisted to `.xitto-kernel/<pack>/allow.json` and remembered across sessions**, so next time the same class auto-passes and is marked "✓ trusted". `/trust` to view, `/trust forget <item>` to revoke, `/trust clear` to wipe. Cautious at first, smoother as you go — dangerous commands are never written into trust, every one is gated each time.

**Sedimenting experience while running (project playbook)**: when the agent figures out "how this project does things" (build/test/deploy commands, conventions, required steps, pitfalls and fixes), it uses `playbook_update` to record it by topic into `.xitto-kernel/<pack>/playbook.md` (same topic overwrites — naturally deduplicated); **the next session auto-loads it into the system prompt, so it doesn't have to rediscover everything**. Because the file is bound to cwd, the playbook naturally only applies to this project. `/playbook` to view, `/playbook forget <topic>`, `/playbook clear`. Division of labor: `memory` stores facts/preferences/decisions (flat), `playbook` stores repeatable procedural knowledge (by topic).

**Self-crystallizing skills (crystallization layer, must be verified)**: once it works out a repeatable procedure/SOP, the agent uses `skill_save` to **write it as a new skill** (markdown) into `.xitto-kernel/<pack>/skills/`. **Policy gate: every new skill must include (1) a clear `goal` and (2) one `verify` command — verify actually runs in the sandbox, and the skill only lands if it passes (exit 0)**, otherwise it's rejected and the output is returned for the agent to fix (dangerous commands are always blocked). This ensures what crystallizes is "verified success", not "claimed success". **The skill is usable immediately this session via `skill` loaded by name (hot scan), and future sessions list it automatically under "available skills"** (progressive disclosure: the prompt only lists name + summary, loading the full text on demand). **Self-maintenance**: loading records usage (`usedCount`); `skills_check`/`/skills check` re-runs each skill's stored verify to detect **drift** — ones invalidated by project changes surface as `⚠ stale` for you to fix or delete, keeping the skill library trustworthy (stale ones are flagged in the prompt so they aren't misused). `/skills` to view (incl. usage/staleness), `/skills forget <name>` to remove. Division of labor: `playbook` is project-factual know-how, `skill` is a cross-task reusable and **verified** procedure. This layer lets the agent **grow its own skill library like Voyager** — but every entry is verified, self-checks, and runs inside the kernel's sandbox + progressive-trust governance.

**Episodic memory + relevance recall (episodic layer)**: after finishing a valuable task, the agent uses `episode_record` to log an episode (summary + tags + success/failure) into `.xitto-kernel/<pack>/episodes.jsonl`. **The key is recall, not storage**: on a similar task, the kernel **automatically** injects the top-K past episodes most relevant to the current input (relevance score: keyword / Chinese bigram overlap + tag weighting + slight recency bias) into that turn's prompt — **only the few most relevant, not the whole dump** (to avoid diluting context or misleading). You can also recall actively via `episode_recall`. Logging does Jaccard dedup to avoid bloat. `/episodes` lists recent, `/episodes <keyword>` tests recall, `/episodes clear`. This directly solves the real bottleneck of every memory system — **recalling the right few** (zero-dependency, explainable scoring, not black-box embeddings).

**Automatic fact extraction (fact layer)**: after each turn, the kernel uses one lightweight LLM call to **automatically** extract "persistent facts worth remembering across sessions" (preferences, identity, long-term decisions, stable settings) into `memory` — no longer relying only on the agent voluntarily calling `memory_save`. One-off task details / small talk are skipped (that's the episodic layer's job), and already-known facts are filtered out as duplicates. **Non-blocking** (hung on the `memoryExtraction` promise returned by `runTurn`, doesn't stall the reply); toggle via `config.autoExtractMemory` (on by default in the CLI), and `api.extractMemory()` can trigger it manually. Mirrors xitto's extractMemory.

### Sedimenting experience: all five layers

The agent accumulates experience automatically while running, and every layer is governed:

| Layer | What it sediments | Mechanism |
|---|---|---|
| Reflex layer | What's safe | progressive trust (per-pattern, across sessions) |
| Fact layer | Things to remember | per-turn auto-extraction of persistent facts into memory |
| Procedure layer | How to do this project | playbook (by topic, auto-injected) |
| Episodic layer | What it has done | episodes + **relevance recall** (inject only the most relevant few) |
| Crystallization layer | Reusable procedures | self-written skills (must verify + self-check for drift) |

**General autonomous agent (give a goal, it finishes it itself)**
```bash
xitto-kernel --pack general --yes --goal "Fetch a summary of example.com and write it in Traditional Chinese into summary.txt"
```
The `general` pack (files/shell/web_fetch) + the kernel's **goal loop** (repeated runTurn + LLM self-verification until done / no progress / limit). In interactive mode use `/goal <goal>`.

**Outcome-oriented: conversation is just the process, the deliverable is the product**

For non-technical users, what they really want isn't "chatting with an AI" — it's "get it done, give me the result." `api.runOutcome(goal)` runs the goal loop and returns not a conversation but a **deliverable**:
```js
const o = await kernel.runOutcome('Create greet.js and write an example to verify it');
// → { done, summary (what it did), artifacts: { created:[...], modified:[...] }, rounds }
```
Both `--goal` and the server's `POST /v1/tasks` (mode=goal) return deliverables — **the files produced/changed** (diffing the working directory before/after, catching even what bash wrote) + a summary + whether the goal was met. Conversation is demoted to process; the result (files/completion) is put front and center. Background-task webhooks also carry `artifacts`.

**Clarification channel (interrupts you only when it truly must)**: the risk of autonomous delivery is "autonomously going wrong." The `ask_user` tool lets the agent pause and ask when **key information is missing and can't be reasonably inferred** — rather than blindly guessing or constantly interrupting (the prompt explicitly guides: if a reasonable default works, don't ask). The app injects `config.askUser` to decide the form of "asking":
- **CLI**: inline question, you type the answer, the agent continues
- **Background task**: the task moves to `needs-input` state and parks the question → you `POST /v1/tasks/:id/answer` → the pause is released and it continues (you can answer hours later, fully asynchronous)

In practice: given "create a config file but I haven't decided the filename/content yet" → the agent doesn't guess, pauses to ask for the filename and content → only delivers the correct `app.config.json` after you answer. This makes "wish → deliver" both autonomous and in control.

**🪄 Wishboard web UI (for non-technical users: open a browser and go)**
```bash
xitto-kernel serve                         # global install → open http://localhost:8787/ (also serves the /chat page)
xitto-kernel serve --port 9000 --local --token secret   # pick a real folder & edit in place; set a token
```
`xitto-kernel serve` flags: `--port` `--local` `--token` `--no-sandbox` `--concurrency` `--model` (run `xitto-kernel serve --help`). Developing this repo instead? Use the npm scripts:
```bash
XITTO_SERVER_TOKEN=secret npm run serve   # then open http://localhost:8787/ in a browser
# Local in-place mode (pick a real folder, edit files in place, sandbox off):
npm run serve:local                        # cross-platform (Windows/macOS/Linux); = LOCAL=1 SANDBOX=off, token defaults to secret (override with XITTO_SERVER_TOKEN)
```
`npm run serve:local` works on every OS (it runs `node scripts/serve-local.js`, no shell-specific syntax). If you'd rather set the env vars yourself:
```powershell
# Windows PowerShell
$env:XITTO_SERVER_LOCAL="1"; $env:XITTO_SERVER_SANDBOX="off"; $env:XITTO_SERVER_TOKEN="secret"; node src/app/server.js
```
```cmd
:: Windows cmd.exe
set XITTO_SERVER_LOCAL=1 && set XITTO_SERVER_SANDBOX=off && set XITTO_SERVER_TOKEN=secret && node src/app/server.js
```
(Change the port with `PORT=8799` / `$env:PORT="8799"` / `set PORT=8799`.)
No terminal, no touching keys (managed server-side). The interface centers on **results**, not chat:
- **Wish**: type one line of "what you want done" → submit (runs the goal loop in the background)
- **In progress**: **live progress + proof of life** — a heartbeat clock ticking "elapsed Ns" every second, the current phase (thinking / acting / verifying), the agent's current **thinking text** (💭), tool actions translated into plain language, the round number + action count. You can see what it's thinking and doing
- **Todo checklist**: when the agent plans a multi-step task with `todo_write`, it shows a ☐/◐/☑ list, turning "unknown duration" into "visible remaining steps" (à la Claude Code)
- **Stop anytime**: every in-progress task has a "Stop" button → `POST /v1/tasks/:id/cancel` (aborts the running agent). Control stays with the user, reducing the anxiety of "starting something you can't control"
- **Expand the process**: quiet by default (just progress and deliverables); want details, click "Expand process" → full step cards (read/edit/run, in plain language) + **colored diffs of edits** (green +/red -). One screen serves both "just give me the result" and "I want to see the details" (à la Claude Code's ⏺/⎿ + ctrl+r expand)
- **Needs your answer**: when the agent pauses to ask, a question + answer box pops up (clarification channel)
- **Collect deliverables**: on completion it shows a summary + **the files produced**, click a filename to view its content directly (`GET /v1/tasks/:id/file`, path-traversal protected)
- **Continue / adjust (iteration with context)**: each deliverable has "↳ Continue / adjust this result" — type one line of what to change / dig deeper into, submitting a **follow-up task** that **continues this conversation (sessionId) + the same workspace**. The agent has both "the files + the discussion and reasoning at the time", not just the files. By default each wish is a clean new conversation (no bloat); clicking "Continue" picks up that thread (like ChatGPT starting a new chat vs continuing one). History marks continuation chains with `↳`
- **Deliverable history**: a list of past wishes (the wish + status), not a chat thread

**Single-page layout (no tabs, everything at a glance)**: a **wish input** at the top + a left column (**deliverable history** + **📂 file browser**, each scrolling internally) + a main area (shared by **current task / progress / deliverables / file preview**). No tab switching — submitting a task, viewing history, browsing workspace files, and previewing content all on one page. The file browser navigates **level by level** (like a file explorer, not recursively flattened all at once), and clicking any file (deliverable or workspace) previews it in the main area. Container is 1180px, narrow screens (≤860px) collapse to a single column automatically. Deliberately kept lightweight (not an IDE).

**Persistent workspace (relationships between deliverables)**: each deliverable is an **independent conversation** (doesn't continue the previous one, avoiding context bloat), but they **share one persistent workspace** (`.xitto-server/ws/<workspace>`, default `default`) — so ① **files persist**, and later tasks can build on earlier results ("translate the plan.md I made last time into English"); ② **the five experience layers accumulate across deliverables** (preferences/skills/episodes/trust) — it **understands you better the more you use it**, no longer a stranger starting from scratch each time. `workspace` can be specified at POST time (one per user for multi-user); the web UI has a "Project" dropdown to switch, and each deliverable card marks its `📁 owning workspace`.

**Local in-place mode (edit a real folder you pick, like Claude Code)**: with `XITTO_SERVER_LOCAL=1`, the web UI gains a "**📁 Pick folder**" button — **click your way** from the home directory into your real folder and select it (no typing paths; the browser can't get absolute paths, so the local server lists folders), or "New project" by pasting an absolute path directly. The task then **edits the files in that folder in place** (no separate isolated copy), and the workbench lists it too. This bridges two models — "Wishboard (isolated, serving non-technical users)" and "Claude Code (in-place, editing your existing codebase)": **local self-use, want in-place → give a path; isolated/hosted → give a name**. **Safety**: absolute paths are only honored in `local` mode; **in hosted mode an absolute path is sanitized into a managed workspace and cannot escape to arbitrary host paths**.

**History survives restarts (persistence)**: the task list is persisted to `.xitto-server/tasks/` and conversation sessions to `.xitto-server/sessions/`, reloaded on startup — so **after a restart, deliverable history shows automatically and old deliverables can still be "continued/adjusted"** (the conversation context is there too). Tasks still running/awaiting-answer at restart are marked "interrupted (restart)". Mirrors Claude Code's "conversations auto-persist", but the Wishboard **auto-displays history** (a deliverable list) rather than Claude Code's explicit `--resume`.

**Provenance / file location**: a deliverable records its **logical location (workspace)**; the **physical absolute path** is hidden by default (hosted mode doesn't leak server paths), shown only in **local mode** (`XITTO_SERVER_LOCAL=1`), where a deliverable carries a "📂 file location" so you can find the file in Finder/Explorer.

A zero-dependency single HTML file (`src/app/web/index.html`), using polling rather than SSE. The token is injected into the page for same-origin calls — zero-config for local self-use; **put real authentication in front for production deployment**.

## Running it as a service (not just a CLI)

The kernel is UI-agnostic; the CLI is just one app. `src/app/server.js` is a PoC that wraps it into an **HTTP service**
(zero-dependency `node:http`) — proving "personal tool → serviceable foundation":

```bash
XITTO_SERVER_TOKEN=secret npm run serve     # http://localhost:8787
curl -s localhost:8787/health
curl -s -XPOST localhost:8787/v1/run -H "Authorization: Bearer secret" \
  -H content-type:application/json -d '{"pack":"general","sessionId":"s1","input":"..."}'
```

Features: bearer-token auth, **per-session isolated working directory + history** (multi-turn remembers context), sandbox (Seatbelt),
structured JSON logs (audit/observability), 6 packs to choose from, JSON or SSE (`/v1/stream`) streaming.
"Personal vs production" is an **app-layer** concern — same kernel, the CLI and the server are two apps.

**Background tasks + completion notification (asynchronous interaction)** — dispatch a task, get a `taskId` immediately, and have a webhook called on completion, without watching it constantly:
```bash
# Dispatch a task (returns 202 + taskId immediately), POSTs the result to the webhook on completion
curl -s -XPOST localhost:8787/v1/tasks -H "Authorization: Bearer secret" \
  -H content-type:application/json \
  -d '{"pack":"general","mode":"goal","goal":"...","webhook":"https://your-service/done"}'

curl -s localhost:8787/v1/tasks            -H "Authorization: Bearer secret"   # list
curl -s localhost:8787/v1/tasks/<id>       -H "Authorization: Bearer secret"   # status + result
curl -sN localhost:8787/v1/tasks/<id>/events -H "Authorization: Bearer secret" # attach to event stream (SSE, replay + live)
```
Concurrency limited by `XITTO_SERVER_CONCURRENCY` (default 2); on completion the webhook receives `{taskId,status,text,usage,rounds,done}`.
This extends "watch it live" into a "dispatch → notify" asynchronous form (like treating the agent as a coworker).

## Build your own domain agent (without freezing in)

The kernel is a **depended-on package**, not a template to clone. Your agent is a small standalone project:

```bash
xitto-kernel new-agent my-bot      # produces a standalone project (imports the kernel, doesn't modify it)
cd my-bot && npm install && npm start
```

The generated `my-bot/` has only: `pack.js` (your domain: what it can do / what it guards) + `index.js` (a few lines to start) + `package.json` (`"xitto-kernel": "file:…"`).
The runtime (multi-step loop / streaming / permissions / sandbox / CLI) all lives in the kernel; `npm update xitto-kernel` upgrades the foundation and **your agent doesn't get frozen in**.

```
my-bot/                    ← your standalone project
├── package.json           dependencies: { xitto-kernel: file:… }
├── pack.js                ← your DomainPack
└── index.js               import { runCli, loadModel } from 'xitto-kernel/app'
```

> The built-in coding / data-query / notes packs are "official example packs" that live in the kernel repo; your pack lives in your own project. They coexist without freezing each other in.

## Build status

```
xitto-kernel/
├── src/
│   ├── types.js                  type definitions (DomainPack / Tool / KernelServices …)
│   ├── index.js                  public API (createKernel / loadPack / defineDomainPack …)
│   ├── kernel/
│   │   ├── pack-loader.js        ✅ pack loading/validation
│   │   ├── tool-registry.js      ✅ tool-metadata driven (replaces a hard-coded list)
│   │   ├── guard-chain.js        ✅ fixed-order beforeToolCall guard chain
│   │   ├── agent-loop.js         ✅ Agent ported from xitto-code (streaming + multi-step tool loop)
│   │   ├── provider.js           ✅ provider-call adapter (pi-ai streamSimple + cache compatible)
│   │   ├── security/             ✅ real sandbox (guard-chain slot 5)
│   │   │   ├── sandbox.js        ✅ static policy + macOS Seatbelt OS-level isolation
│   │   │   ├── danger.js         ✅ dangerous-command detection (rm -rf / fork bomb / curl|sh …)
│   │   │   ├── allow.js          ✅ command-signature allowlist
│   │   │   └── permission-step.js ✅ slot 5: deny→static policy→danger→confirm (metadata driven)
│   │   └── index.js              ✅ createKernel: runTool + runTurn + sandbox wiring
│   ├── app/                      ✅ app layer (thin; the TUI is not inside the kernel)
│   │   ├── index.js              ✅ xitto-kernel/app public API (runCli/loadModel/newAgent)
│   │   ├── cli.js                ✅ interactive CLI: streaming text + tool display + /commands + Ctrl+C interrupt
│   │   ├── main.js               ✅ entry point + new-agent subcommand
│   │   ├── scaffold.js           ✅ scaffolding: produce a standalone agent project (doesn't modify the kernel)
│   │   ├── templates/            ✅ standalone-project templates (package.json/index.js/pack.js…)
│   │   └── providers.js          ✅ providers.json loading (provider config is an app concern, not the kernel's)
│   └── packs/
│       ├── coding/               ✅ reference pack (read/ls/write/edit/bash/git)
│       ├── data-query/           ✅ second domain (proves orthogonality)
│       ├── notes/                ✅ third domain (knowledge base)
│       ├── general/              ✅ general autonomous agent (files/shell/web/http + goal loop)
│       ├── deep-research/        ✅ deep research (multi-source search → verify → cited conclusion)
│       ├── devops/               ✅ ops/SRE (shell + bash_bg + config + logs + health checks)
│       └── uiux/                 ✅ UI/UX (design-system aware + WCAG a11y verify gate)
├── bin/xitto-kernel.js           ✅ CLI entry point (run / new-agent)
├── test/                         ✅ all tests green (runTurn + Seatbelt isolation + scaffolding + …)
└── examples/
    ├── demo.js                   ✅ no LLM: same kernel, two domains, guards genuinely in effect
    └── live.js                   ✅ real LLM (MiniMax): the model actually calls tools to finish a task
```

**Also runnable**: `npm test` (200+ tests, all green), `npm run demo` (no LLM), `node examples/live.js` (real LLM).
**runTurn is ported**: the multi-step loop of stream → tool call (through the kernel guard chain) → feed back → stream again, drivable by a real provider.
**Real sandbox is wired into guard-chain slot 5**: (A) static policy blocks network/privilege-escalation/dangerous commands; (B) macOS Seatbelt provides runtime OS-level isolation, catching obfuscated out-of-bounds writes the static policy missed. `sandboxable` tools are auto-wrapped, `tool.readOnly` is auto-passed — all metadata driven, no domain lists.
**Still seams (later)**: in-turn compaction, hooks/skills/MCP/subagent, contextFiles loading, interactive permission confirmation (the CLI currently passes mutating tools headlessly; dangerous commands are still blocked). A richer Ink TUI can be another app consuming the same kernel events.

## Documentation index

| Doc | Contents |
|------|------|
| [01-architecture.md](docs/01-architecture.md) | Layered architecture, kernel module list, the lifecycle of one turn, and the kernel/pack boundary |
| [02-domain-pack-spec.md](docs/02-domain-pack-spec.md) | Full spec of the `DomainPack` interface (per field, required/optional, defaults) |
| [03-kernel-contract.md](docs/03-kernel-contract.md) | The services the kernel provides to a pack (`KernelServices`) and lifecycle hooks |
| [04-migration-from-xitto-code.md](docs/04-migration-from-xitto-code.md) | Concrete steps for extracting from xitto-code: how each coupling point moves, and the risks |
| [05-example-packs.md](docs/05-example-packs.md) | Example pack comparison (coding / data-query built in + ops sketch), proving the same interface runs different domains |
| [06-authoring-a-pack.md](docs/06-authoring-a-pack.md) | **How to build a new domain agent on the foundation**: minimal pack, tool shape, three steps, tool vs prompt |

## Status and next steps

**Done**: the pack system, tool-metadata-driven tools, fixed-order guard chain, agent loop (real-LLM multi-step loop),
real sandbox (static policy + macOS Seatbelt), pack.verify self-acceptance, pack.contextFiles loading,
**cross-session memory + resume**, **interactive permission confirmation** (/auto, --yes), **/plan plan mode + /undo**,
**git capabilities** (coding pack), **spawn_agent subagents**, **PreToolUse/PostToolUse hooks**,
**skills progressive disclosure**, **MCP tool integration**, the interactive CLI, scaffolding (`new-agent` produces a standalone project). All tests green (200+).

**Published on npm**: `npm install -g xitto-kernel`; projects produced by `new-agent` depend on `^0.1.0` by default (`--local` uses file: for development).
**Optional next**: a full-featured Ink TUI as another app (the CLI already has lightweight streaming markdown + colored diffs).

**Design stance**: stays on Node ESM + the pi-ai provider abstraction; doesn't rewrite xitto-code (the kernel is an abstraction; xitto-code can still exist independently).

## Evaluation (capability is quantifiable)

Each pack ships with an EvalSuite (`eval/`, sharing `eval/framework.js`, not part of the npm package).
Paradigm: **a new-domain agent = a new pack (what it can do) + a new EvalSuite (how to score it)**.

| Suite | Benchmarked against | Scoring | How to run | Reference result* |
|------|------|------|------|------|
| coding | SWE-bench Verified | hidden tests fail→pass (Docker) | `eval/swebench-generate.js` + official harness | 3/8 resolved (real subset) |
| coding (mini) | SWE-bench style | hidden tests (no Docker) | `npm run eval` | 4/4 |
| general | GAIA style | answer match / state check | `node eval/general-run.js` | 4/4 |
| data-query | Spider/BIRD style | real SQLite + answer match | `node eval/data-query-run.js` | 4/4 |
| deep-research | GAIA/research | factual correctness + genuine verification (allOf) | `node eval/deep-research-run.js` | 3/3 |
| devops | Terminal-Bench style | state check (system/files meet target) | `node eval/devops-run.js` | 4/4 |
| uiux | v0 style | a11y static audit (WCAG, 0 issues) + structure check (allOf) | `node eval/uiux-run.js` | 4/4 |
| tool calling | BFCL style | trajectory check (calls the right tool/params) | `node eval/tool-calling-run.js` | 6/6 |

\* Reference numbers run with MiniMax-M2.7 (small sample); for swapping models / expanding the sample see `eval/README.md`. Scorer types: `answerMatch` / `stateCheck` / `toolCalled`.

## Security

xitto-kernel runs an agent that **executes commands and edits files chosen by an LLM**. Treat it like running code you didn't write. Key caveats before you deploy:

- **OS sandbox is macOS-only.** The real isolation layer is macOS Seatbelt. On **Linux/Windows there is no OS-level sandbox** — the agent runs commands with your user's privileges. Run untrusted goals inside a container/VM or a throwaway environment.
- **The example HTTP server is an unhardened PoC.** The bearer token is injected into the page for same-origin calls and there is no rate limiting. **Never expose it unauthenticated to the public internet** — put real authentication and TLS in front, and prefer running it locally.
- **Prompt injection is a real surface.** Web pages, files, and tool output the agent reads can carry adversarial instructions. The command-danger detector (`rm -rf`, fork bombs, `curl | sh`, …), the command-signature allowlist, and progressive trust reduce the blast radius but do not eliminate it. Dangerous commands are always gated; review what you grant trust to.
- **Keys never need to land on disk.** Reference API keys via env vars (`${NAME}`) in `providers.json`, which is git-ignored.

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md). Do not open a public issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Core principle: the kernel must stay domain-agnostic (safety behavior comes from tool metadata, not hard-coded domain lists); a new domain = adding a pack, with zero kernel changes.

## License

[MIT](LICENSE) © ishoplus
