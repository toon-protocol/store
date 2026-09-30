# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**.

## Before exploring, read these

- **`CLAUDE.md`** at the repo root. It says what the store is, what `deploy/` is, and where
  claim validation lives (the connector, never here).
- **`README.md`** for the operator's view of the app and the box.
- **`deploy/README.md`** before touching anything under `deploy/`.

There is no `CONTEXT.md`, no `docs/adr/` and no `CONTEXT-MAP.md` in this repo. The shared
project context and the ADRs that bind it live in other repositories:

- [`toon-protocol/connector`](https://github.com/toon-protocol/connector) has `CONTEXT.md`
  (the vocabulary the payment path uses) and `docs/adr/`. The connector's ADRs settle
  anything about the payment path, claim validation and the connector image pin.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill creates a `CONTEXT.md` or an ADR lazily
when terms or decisions actually get resolved.

## Use the vocabulary the repo already uses

Use the connector's terms when you name a payment concept: **connector**, **app** or
**handler** (the payment-oblivious service behind a route's `handler_url`, which is what this
repo's `POST /store` backend is). Don't write "terminator", "BLS" or "agent runtime": all three
are retired names.

## Flag ADR conflicts

If your output contradicts a connector ADR, surface it explicitly rather than silently
overriding it, and name the ADR.
