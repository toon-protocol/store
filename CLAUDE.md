# store

The TOON Protocol **store** — NIP-90 **kind:5094** Arweave blob storage. Built from `Dockerfile.store` over `src/entrypoint-store.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`: upload the blob to Arweave via Turbo, return the tx id. This is a **container, not an npm package** (`@toon-protocol/store`, kept private). It runs as a payment-oblivious `POST /store` backend (`src/store-backend.ts`) behind the connector, which is the front-of-app payment proxy and reverse-proxies to it (RouteTermination — see `deploy/`).

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos.

> **Follow-ups:** this repo was carved from the monorepo `docker/` aggregator and still contains the other images' build contexts — trim to store-only (keep `Dockerfile.store` + `src/entrypoint-store.ts` + `src/store-backend.ts` + shared helpers). The image-publish workflows now exist: `publish-store-image.yml` (the store app) and `publish-store-connector-image.yml` (the connector-with-config payment proxy).

## Build
This builds a Docker image, not an npm package:
```
pnpm install
pnpm build            # esbuild bundle of the entrypoint
docker build -f Dockerfile.store -t toon-store .
```

## Shared skills, docs & project context → toon-protocol/toon-meta
Cross-cutting agent skills, docs, and the canonical project context live in **[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**. Load the shared skills:
```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```
Canonical rules/decisions: `toon-meta` → `_bmad-output/project-context.md`.

## Cross-repo dependencies
- Consumes `@toon-protocol/{core,sdk,bls}` from **npm** (pinned semver) — the Arweave handler lives in `sdk`.
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo. The DVM receives ILP packets from the connector via HTTP and trusts they were already validated; **claim validation lives ONLY in the connector.**
