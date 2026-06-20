# store

TOON Protocol **Arweave DVM node** — NIP-90 kind:5094 blob storage. The node accepts a paid claim (routed via the hub/connector), uploads the blob to Arweave via Turbo, and returns the tx id. Built from `Dockerfile.dvm` over `src/entrypoint-dvm.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`.

Publishes no npm package (it's a container); kept `private`.

> Extracted from the TOON monorepo with full git history preserved.
