# store

TOON Protocol **Arweave DVM node** — NIP-90 kind:5094 blob storage. The node accepts a paid claim (routed via the hub/connector), uploads the blob to Arweave via Turbo, and returns the tx id. Built from `Dockerfile.dvm` over `src/entrypoint-dvm.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`.

## Status / follow-ups
- Add the **image-publish workflow** (carve from the monorepo `publish-townhouse-images.yml`'s dvm job): multi-arch build → push to GHCR → signed digest.
- `Dockerfile.dvm` still references monorepo paths (`packages/*`, `pnpm-workspace.yaml`, etc.) that do not exist here. Fixing the Dockerfile to build standalone is a separate follow-up.
- Publishes no npm package (it's a container); kept `private`.

> Extracted from the TOON monorepo with full git history preserved.
