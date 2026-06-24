# store

TOON Protocol **store** — NIP-90 kind:5094 Arweave blob storage. It uploads the blob to Arweave via Turbo and returns the tx id. Built from `Dockerfile.store` over `src/entrypoint-store.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`. It runs as a payment-oblivious `POST /store` backend (RouteTermination) behind the connector, which is the front-of-app payment proxy — see [`deploy/`](./deploy).

## Status / follow-ups
- This repo was carved from the monorepo's `docker/` aggregator and **still contains the other images' build contexts** (Dockerfile.town/mill/townhouse-api + their entrypoints). **Trim to store-only** (keep `Dockerfile.store` + `src/entrypoint-store.ts` + `src/store-backend.ts` + shared helpers).
- Image-publish workflows: **`publish-store-image.yml`** (the store app → `ghcr.io/toon-protocol/store`) and **`publish-store-connector-image.yml`** (the connector-with-config payment proxy → `ghcr.io/toon-protocol/store-connector`). Consumers pinning the old `…/dvm` image must move to `…/store`.
- Publishes no npm package (it's a container); kept `private`.

> Extracted from the TOON monorepo with full git history preserved.

## Getting started with Devbox

[Devbox](https://github.com/jetify-com/devbox) pins the local toolchain to the exact
versions CI uses — Node 22 and pnpm 8.15.x — so `pnpm build`, `pnpm test`, and
`pnpm typecheck` run in a reproducible shell without touching your system packages.

**Prerequisites:** [Install devbox](https://www.jetify.com/devbox/docs/installing_devbox/) (one-liner).

```bash
# Enter the pinned shell (downloads packages on first run via Nix)
devbox shell

# Inside the devbox shell, all tools are on PATH:
node --version    # v22.x
pnpm --version    # 8.15.x

# Run the standard targets (defined as devbox scripts)
devbox run build     # pnpm install --frozen-lockfile && pnpm build
devbox run typecheck # pnpm typecheck
devbox run test      # pnpm test
```

`.devbox/` (the Nix symlink/cache dir) is gitignored; `devbox.json` and `devbox.lock`
are committed.
