# store

TOON Protocol **Arweave DVM node** — NIP-90 kind:5094 blob storage. The node accepts a paid claim (routed via the hub/connector), uploads the blob to Arweave via Turbo, and returns the tx id. Built from `Dockerfile.dvm` over `src/entrypoint-dvm.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`.

## Getting started with Devbox

Install [Devbox](https://github.com/jetify-com/devbox), then:

```sh
devbox install        # pin Node 20 + pnpm 8.15.0
devbox shell          # enter the reproducible environment
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

## Status / follow-ups
- This repo was carved from the monorepo's `docker/` aggregator and **still contains the other images' build contexts** (Dockerfile.town/mill/townhouse-api + their entrypoints). **Trim to dvm-only** (keep `Dockerfile.dvm` + `src/entrypoint-dvm.ts` + shared helpers).
- Add the **image-publish workflow** (carve from the monorepo `publish-townhouse-images.yml`'s dvm job): multi-arch build → push to GHCR → signed digest.
- Publishes no npm package (it's a container); kept `private`.

> Extracted from the TOON monorepo with full git history preserved.
