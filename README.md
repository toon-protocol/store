# store

TOON Protocol **store** — NIP-90 kind:5094 Arweave blob storage. It uploads the blob to Arweave via Turbo and returns the tx id. Built from `Dockerfile.store` over `src/entrypoint-store.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`. It runs as a payment-oblivious `POST /store` backend (RouteTermination) behind the connector, which is the front-of-app payment proxy — see [`deploy/`](./deploy).

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
**connector** deployment. Canonical source: the connector repo's
`infra/linode/endpoints.json` + toon-meta `docs/deployment.md`. Highlights
(devnet/testnet only — **TOON has no mainnet deployments**):

| Chain / network | What | Id |
|---|---|---|
| Solana devnet | payment-channel program | *non-deterministic* — regenerated per provision (`cargo build-sbf`); read it from the live box `connector.yaml` / kind:10032 announce, never from docs |
| Solana devnet | mock USDC SPL mint (6dp) | `H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H` |
| Mina public devnet | mock-USDC `UsdcChannelToken` FungibleToken (6dp, redeployed 2026-07-17 with the connector#352 single-o1js tooling) | token `B62qmM6queHpUAWW1G6Hkb5MCEk1xKZ2wmydVdke4LvtZ8mL3AYkRKw` · tokenId `11023656268526876025673184191684945855837551514830012586280356683923962762116` · admin contract `B62qkHwT6qbkqyyrxVs8cPBmmVJTVX5es63DKZK9vewNWRD2Vs5jE2k` · vk hash `9692307225143487166733467413506207145324336685411164992097971188215422741850` |
| Mina public devnet | `PaymentChannel` zkApp | *per-channel* — the zkApp address IS the channel id; each channel is a fresh bare deploy the client initializes (issue #185 discipline). No single canonical address exists. |
| EVM | TokenNetworkRegistry / TokenNetwork / MockUSDC | box-devnet (anvil 31337) addresses in toon-meta `docs/deployment.md`; Base-Sepolia addresses were never committed (`e2e/testnets.json` gap — see toon-meta `docs/e2e-testnets.md`) |
