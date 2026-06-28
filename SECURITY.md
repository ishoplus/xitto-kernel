# Security Policy

xitto-kernel runs an agent that **executes commands and edits files chosen by an LLM**. Please read the "Security" section of the [README](./README.md#security) before deploying or exposing it.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's **[Private vulnerability reporting](https://github.com/ishoplus/xitto-kernel/security/advisories/new)** ("Report a vulnerability" under the repo's *Security* tab). If that is unavailable, contact the maintainer through their GitHub profile ([@ishoplus](https://github.com/ishoplus)).

Please include:
- affected version (`xitto-kernel --version` or `package.json`) and OS,
- a minimal reproduction or proof of concept,
- the impact you believe it has.

We aim to acknowledge a report within a few days and to coordinate a fix and disclosure timeline with you. Credit is given to reporters unless you prefer to remain anonymous.

## Supported versions

This project is pre-1.0 and moves fast. Security fixes target the **latest published `0.x` release** on npm. Please upgrade before reporting if you are on an older version.

## Scope

In scope: the kernel's guard chain / sandbox / permission model, the command-danger detector, path-traversal protection in the server, and anything that lets an agent escape its intended boundaries.

Out of scope (known and documented in the README, not vulnerabilities): the example HTTP server is an unhardened PoC (token injected into the page, no rate limiting); OS-level sandboxing is **macOS-only** (Seatbelt) — on other platforms the agent runs commands without OS isolation. Run untrusted workloads in a container/VM and put real authentication in front of any network-exposed deployment.

---

繁體中文：本專案的 agent 會**執行 LLM 決定的命令、修改檔案**。回報漏洞請走 GitHub 私密通報（Security 分頁的「Report a vulnerability」），**勿開公開 issue**。安全邊界與已知限制見 README 的「Security」段。
