# store

TOON Protocol **store** — NIP-90 kind:5094 Arweave blob storage, plus two optional job kinds: kind:5095 ArNS brokered buy (gated by `ARNS_DVM_SOLANA_SECRET_KEY`) and kind:5096 gas-station co-sign/broadcast (gated by `GAS_STATION_SOLANA_SECRET_KEY`). It uploads the blob to Arweave via Turbo and returns the tx id. Built from `Dockerfile.store` over `src/entrypoint-store.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`. It runs as a payment-oblivious `POST /store` backend (RouteTermination) behind the connector, which is the front-of-app payment proxy — see [`deploy/`](./deploy).

## Status / follow-ups
- Trimmed to store-only: the repo is now `Dockerfile.store` + `src/entrypoint-store.ts` + `src/store-backend.ts`. The other images' carried-over build contexts (`Dockerfile.{town,mill,townhouse-api,akash-*,oyster,nix,sdk-e2e,toon-client,…}`, their `src/entrypoint-*` files, and the `configs/`, `dev-fixtures/`, `akash-ator-probe/`, `townhouse-ator-sidecar/` dirs) have been removed.
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

## Public network ids — zkApps / programs the store's jobs touch

The store's paid jobs execute against **public, third-party on-chain programs**.
These ids are network-scoped; misconfiguring them silently targets the wrong
registry. Canonical machine-readable source: **`@ar.io/sdk` ≥ 4.0.3 exports**
(`DEVNET_PROGRAM_IDS`, `ARIO_*_PROGRAM_ID`); this table is the human-readable
snapshot (verified live 2026-07-17).

### ar.io Solana programs (kind:5095 arns-buy + kind:5096 whitelist)

| Program | Solana **mainnet** | Solana **devnet** (`ARNS_NETWORK=devnet`, default) |
|---|---|---|
| ario-core | `73YoECm6NKXpVRoe5f1Q9BcP5DJGPFUjnFy6AxBE5Nvh` | `8Njx9wPkXiNzDCgjwVsJFRjpAEV34gGW3n8DzX3V23m1` |
| ario-gar | `89fNiiwgpFSPHKuqfNUkgYTYjtAJAhyqHjXmgXeppGpf` | `7WsDTrtZBsfKtnP33XkjuqXCY69JE7n4QVYpynqJCFxz` |
| ario-arns (name registry) | `2yCUx5edFvUrkibYaUa2ZXWyx9kuJkS8CwyzsgHPWdZZ` | `6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp` |
| ario-ant (ANT state) | `2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5` | `DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX` |
| ario-ant-escrow | — (not exported for mainnet by the SDK) | `bttco5oAnBwCucG63iKokBJCZmNr493f3Ewe9LM3oTx` |

- **ar.io has NO deployment on Solana's testnet cluster** — `devnet` and
  `mainnet` are the only valid networks (toon-client#376/#381).
- RPC per network: `https://api.mainnet-beta.solana.com` / `https://api.devnet.solana.com`.

### Cluster-invariant programs (kind:5096 gas-station whitelist)

| Program | Id (same on every cluster) |
|---|---|
| Metaplex Core (`MPL_CORE_PROGRAM`) | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |
| System Program | `11111111111111111111111111111111` |
| ComputeBudget | `ComputeBudget111111111111111111111111111111` |

The kind:5096 gas-station program whitelist = these three + the ar.io programs
for the configured `ARNS_NETWORK` row above (assembled at runtime in
`src/gas-station-handler.ts` from the SDK exports — the table is documentation,
not the source of truth).

### TOON payment-channel contracts (the connector in FRONT of this store)

The store itself is payment-oblivious; the channel contracts belong to the
**connector** deployment. Since the 2026-07-19 public-chain cutover the devnet
settles on public networks. Canonical machine-readable source: the apex's
**kind:10032 announce** on the relay; human-readable: toon-client
[`packages/rig/README.md` § "Devnet reference (public chains)"](https://github.com/toon-protocol/toon-client/blob/main/packages/rig/README.md#devnet-reference-public-chains)
+ toon-meta [`docs/deployment.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/deployment.md).
Snapshot (devnet/testnet only — **TOON has no mainnet deployments**):

| Chain / network | What | Id |
|---|---|---|
| Solana devnet | payment-channel program (fixed public deployment) | `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip` |
| Solana devnet | mock USDC SPL mint (6dp) | `xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in` |
| Mina public devnet | canonical USDC token (6dp) | token `B62qqN1Pu3kF2KGmqLA8EwpqfWrnFTVZJGDSDHQuQRoVt5BCFjhNz3d` · tokenId `9497120696276615621907376728658022802954262638363646162765282600447713419198` |
| Mina public devnet | `PaymentChannel` zkApp | `B62qmgPhv2Xo6QVEtwjLja8UZJUtu8yapRFAR6gaoGtbM9zE5hG7Tkf` |
| Base Sepolia (`evm:84532`) | TokenNetworkRegistry / TokenNetwork / USDC | registry `0xcC9079adE929b168B54145f6d25262b64FAB9D5b` · TokenNetwork `0x1E95493fEF46707E034b4a1945f25a8C76A1823D` · USDC `0x49beE1Bca5d15Fb0963117923403F9498119a9Ce` |
