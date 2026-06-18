# store

TOON Protocol **Arweave DVM node** — NIP-90 kind:5094 blob storage. The node accepts a paid claim (routed via the hub/connector), uploads the blob to Arweave via Turbo, and returns the tx id. Built from `Dockerfile.dvm` over `src/entrypoint-dvm.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`.

## Status / follow-ups
- This repo was carved from the monorepo's `docker/` aggregator and **still contains the other images' build contexts** (Dockerfile.town/mill/townhouse-api + their entrypoints). **Trim to dvm-only** (keep `Dockerfile.dvm` + `src/entrypoint-dvm.ts` + shared helpers).
- Add the **image-publish workflow** (carve from the monorepo `publish-townhouse-images.yml`'s dvm job): multi-arch build → push to GHCR → signed digest.
- Publishes no npm package (it's a container); kept `private`.

> Extracted from the TOON monorepo with full git history preserved.

## Development

### Getting started with Devbox

[Devbox](https://www.jetify.com/devbox) pins the exact versions of Node and jq used in CI so your local shell matches the CI toolchain automatically.

**Prerequisites:** [install Devbox](https://www.jetify.com/devbox/docs/installing_devbox/) (requires Nix; the installer sets it up).

```sh
devbox shell        # enter the pinned environment (installs tools on first run)
pnpm install        # install Node dependencies
pnpm build          # bundle with esbuild
pnpm test           # run tests
```

All `devbox shell` sessions use the versions declared in `devbox.json`. The `devbox.lock` is committed by the `devbox-validate` CI job on the first PR run to pin exact Nix hashes.
