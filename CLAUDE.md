# store

The TOON Protocol **store** — NIP-90 **kind:5094** Arweave blob storage, plus two optional job kinds: **kind:5095** ArNS brokered buy (`src/arns-buy-handler.ts`, gated by `ARNS_DVM_SOLANA_SECRET_KEY`) and **kind:5096** gas-station co-sign/broadcast (`src/gas-station-handler.ts`, gated by `GAS_STATION_SOLANA_SECRET_KEY`). Built from `Dockerfile.store` over `src/entrypoint-store.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`: upload the blob to Arweave via Turbo, return the tx id. This is a **container, not an npm package** (`@toon-protocol/store`, kept private). It runs as a payment-oblivious `POST /store` backend (`src/store-backend.ts`) behind the connector, which is the front-of-app payment proxy and reverse-proxies to it (RouteTermination — see `deploy/`).

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos.

## Build
This builds a Docker image, not an npm package:
```
pnpm install
pnpm build            # esbuild bundle of the entrypoint
docker build -f Dockerfile.store -t toon-store .
```
Image-publish workflows: `publish-store-image.yml` (the store app) and `publish-store-connector-image.yml` (the connector-with-config payment proxy).

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
