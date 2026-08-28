# store

The TOON Protocol **store** — NIP-90 **kind:5094** Arweave blob storage, plus one optional job kind: **kind:5095** ArNS brokered buy (`src/arns-buy-handler.ts`, gated by `ARNS_DVM_SOLANA_SECRET_KEY`). The gas-station kinds (5096 Solana, 5098 EVM) moved to **[toon-protocol/gas-station](https://github.com/toon-protocol/gas-station)**. Built from `Dockerfile.store` over `src/entrypoint-store.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`: upload the blob to Arweave via Turbo, return the tx id. This is a **container, not an npm package** (`@toon-protocol/store`, kept private). It runs as a payment-oblivious `POST /store` backend (`src/store-backend.ts`) behind the connector, which is the front-of-app payment proxy and reverse-proxies to it (RouteTermination).

`deploy/` **is** the store box, not a sketch of it: five containers (nginx/TLS, connector, store, certbot, Watchtower) that the TOON devnet store box actually runs, installed by `deploy/bootstrap.sh`. The connector image is an immutable `ghcr.io/toon-protocol/connector:rust-sha-<short>` pin (bumped by commit together with the literal in the guard test — connector ADR 0068; nothing moves `:rust-release` any more) with `connector.toml` bind-mounted — there is no derived `store-connector` image any more. Config files are rendered from committed `*.template` files by `deploy/render.sh`; the rendered output and all key material are gitignored. `src/deploy-bundle-guard.test.ts` asserts the bundle stays consistent.

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos.

## Build
This builds a Docker image, not an npm package:
```
pnpm install
pnpm build            # esbuild bundle of the entrypoint
docker build -f Dockerfile.store -t toon-store .
```
Image-publish workflow: `publish-store-image.yml` (the store app → `ghcr.io/toon-protocol/store`, moving the `:release` tag Watchtower follows on every green `main`).

## Shared skills, docs & project context → toon-protocol/toon-meta
Cross-cutting agent skills, docs, and the canonical project context live in **[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**. Load the shared skills:
```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```
Canonical rules/decisions: `toon-meta` → `_bmad-output/project-context.md`.

## Cross-repo dependencies
- Consumes `@toon-protocol/{core,sdk}` from **npm** (pinned semver) — the Arweave handler lives in `sdk`.
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo. The DVM receives ILP packets from the connector via HTTP and trusts they were already validated; **claim validation lives ONLY in the connector.**
