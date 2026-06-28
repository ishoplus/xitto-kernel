# Contributing

**English** · [繁體中文](./CONTRIBUTING.zh-TW.md)

Contributions welcome! xitto-kernel is a domain-agnostic agent foundation.

## Development

```bash
npm install
npm test          # all tests (macOS runs the real Seatbelt isolation tests; other platforms auto-skip)
npm run demo      # architecture demo without an LLM
```

## Principles

- **The kernel must stay domain-agnostic**: `src/kernel/` must never contain a concrete domain's tool name (e.g. hard-coded `'edit'`/`'bash'`). Whether a tool is "read-only / mutating / sandboxable" is decided entirely by the tool's own metadata (`readOnly` / `mutating` / `sandboxable`).
- **The guard-chain order is not bypassable**: a pack may only insert domain guards at slot 3 (`preToolPolicy`); it cannot skip the permission/sandbox slot (slot 5).
- **Domain logic goes in a pack, not the kernel**: a new domain = adding a `DomainPack`, with zero kernel changes. Litmus test: if a requirement needs a kernel change to support, that's domain knowledge leaking — extract it into a new slot or a `KernelServices` capability instead.
- **New tools must carry metadata**: `mutating` / `readOnly` / `sandboxable`, otherwise safety behavior will be wrong.

## Submitting

- Include tests for your change (`test/*.test.js`, run with `node --test`).
- When touching the guard chain / sandbox / agent loop, make sure all tests pass (CI runs on ubuntu + macOS × node 20/22).
- Commit messages may be in Chinese or English — just be clear about the "why".
- For security vulnerabilities, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Architecture docs

Start with [`docs/01-architecture.md`](docs/01-architecture.md), then read [`docs/03-kernel-contract.md`](docs/03-kernel-contract.md) (the invariants).
To build a new domain agent, see [`docs/06-authoring-a-pack.md`](docs/06-authoring-a-pack.md).
