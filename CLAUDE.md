# store

The TOON Protocol **Arweave DVM node** — NIP-90 **kind:5094** blob storage. Built from `Dockerfile.dvm` over `src/entrypoint-dvm.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`: accept a paid claim, upload the blob to Arweave via Turbo, return the tx id in the FULFILL. This is a **container, not an npm package** (`@toon-protocol/store`, kept private).

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos.

> **Follow-ups:** this repo was carved from the monorepo `docker/` aggregator and still contains the other images' build contexts — trim to dvm-only (keep `Dockerfile.dvm` + `src/entrypoint-dvm.ts` + shared helpers). Add the image-publish workflow (carve the dvm job from `publish-townhouse-images.yml`).

## Build
This builds a Docker image, not an npm package:
```
npm install
npm run build         # esbuild bundle of the entrypoint
docker build -f Dockerfile.dvm -t toon-store .
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
