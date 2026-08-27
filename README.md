# store

**A paid Arweave blob store, and a worked example of putting any app behind the
TOON connector.**

```
   client ──── pays ────▶ connector ──── POST /store ────▶ store ──▶ Arweave
                          g.toon.ario     (payment already      returns a
                          0.001 USDC       proven)              transaction id
```

## What this is

The **store** answers NIP-90 `kind:5094` jobs: hand it bytes, it uploads them to
Arweave via Turbo and returns the transaction id.

It is a plain HTTP server that knows nothing about payment. The **connector**
sits in front as the payment proxy — it meters the request, settles it on-chain,
and only then forwards the job over the local network. By the time anything
reaches this code, the money is already collected.

That split is the interesting part, and it is why this repo is worth reading
even if you never store a blob: **`deploy/` is a complete, working deployment**
of a paid service, and swapping the store for your own app is a three-line
change.

## The contract

Everything between the connector and your app is these two halves.

**The connector's side** — one route in `connector.toml`:

```toml
[[routes]]
prefix      = "g.toon.ario"                 # the ILP address clients pay
handler_url = "http://store:3300/store"     # your backend — the path is literal
price       = 1000                          # smallest unit of the token (0.001 USDC)
```

**Your side** — accept a POST, do the work, answer:

```
POST /store
{ "event": { ...a signed Nostr event... } }

→ 200 { "accept": true, "txId": "8ZWWEDIHqnGcsP0KSpdPeNIDvwR9G2ntZH7Y2Y5SoFE" }
```

The connector adds `X-TOON-Payer`, `X-TOON-Amount` and `X-TOON-Chain` headers
that it has already validated. Your backend **trusts them and does not re-check
them** — claim validation lives only in the connector.

The event signature *is* still verified here, but for integrity, not
authorization: it proves the request was not tampered with in transit.
Permission was settled upstream by the payment. See
[`src/store-backend.ts`](./src/store-backend.ts) — it is 210 lines, and it is
the whole seam.

## Job kinds

`kind:5094` is always on. The other three register only when their credential is
present, so a default deployment serves blob storage and nothing else.

| Kind | What it does | Enabled by | Source |
|---|---|---|---|
| **5094** | Arweave blob storage | always on | [`entrypoint-store.ts`](./src/entrypoint-store.ts) |
| **5095** | ArNS brokered name buy | `ARNS_DVM_SOLANA_SECRET_KEY` | [`arns-buy-handler.ts`](./src/arns-buy-handler.ts) |
| **5096** | Solana gas station — co-signs and broadcasts | `GAS_STATION_SOLANA_SECRET_KEY` | [`gas-station-handler.ts`](./src/gas-station-handler.ts) |
| **5098** | EVM gas station — ERC-2771 meta-transaction relayer | `EVM_GAS_STATION_CONFIG_JSON` | [`evm-gas-station-handler.ts`](./src/evm-gas-station-handler.ts) |

Both gas stations follow the same security model: a dedicated fee-payer wallet,
static inspection of the request, simulation with a cost cap, and a whitelist of
what may be called. Neither will ever co-sign opening a payment channel or
claiming from one — only depositing, closing and settling — so an agent can fund
or reclaim its own channel without holding native gas, and nothing more.

## Run it locally

```bash
pnpm install
pnpm build
NODE_NOSTR_SECRET_KEY=$(openssl rand -hex 32) pnpm start
```

Then:

```bash
curl localhost:3400/health
# {"status":"ok","handlerKinds":[5094],"basePricePerByte":"10",...}
```

With no Arweave credentials it uploads on the free tier, which caps one upload
at 100 KB. Set `STORE_ARWEAVE_JWK_B64` to a funded wallet to lift that.

There is no connector in this loop — you are talking to the backend directly,
which is exactly what the connector does once it has been paid.

### With Devbox

[Devbox](https://github.com/jetify-com/devbox) pins Node 22 and pnpm 8.15.x to
the versions CI uses:

```bash
devbox shell
devbox run build && devbox run test
```

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `NODE_NOSTR_SECRET_KEY` | *required* | This node's Nostr identity (64 hex chars) |
| `HANDLER_PORT` | `3300` | The job backend the connector proxies to |
| `BLS_PORT` | `3400` | Health endpoint |
| `STORE_ARWEAVE_JWK_B64` | *(free tier)* | Base64 Arweave JWK; lifts the 100 KB cap |
| `FEE_PER_JOB` | `10` | Advertised price per job |
| `STORE_CONFIG_JSON` / `STORE_CONFIG_PATH` | — | Full config as JSON, in place of the variables above |
| `LOG_LEVEL` | `info` | |

The four job-kind credentials are listed in
[`deploy/.env.example`](./deploy/.env.example), which documents each one and how
to generate it. All of them are treated as secrets: never logged, and deleted
from `process.env` after boot.

## Deploy it

[`deploy/`](./deploy) is the real thing — the six containers the TOON devnet
store box actually runs, not a sketch of them. `./bootstrap.sh` on a fresh
Ubuntu host is the entire install.

Updates are unattended: a green merge to `main` publishes
`ghcr.io/toon-protocol/store:release`, and Watchtower recreates the container
within about a minute. The connector half follows the fleet's `:rust-release`
promotion tag, which only ever moves under supervision.

## Develop

```bash
pnpm build       # esbuild bundle of src/ (dependencies stay external)
pnpm test        # vitest
pnpm typecheck
pnpm lint
```

Tests live beside their source as `src/*.test.ts` and are of three kinds:
unit tests per handler; one end-to-end protocol test
(`kind-5094-encrypted-artifact.test.ts` — real events, real HTTP, real signature
verification, stubbed only at the network edge); and
`deploy-bundle-guard.test.ts`, which is not a unit test at all but a set of
lint-like assertions that the committed deployment still says what the
deployment means.

**Tests never make live-chain calls.** The network is stubbed at the edge, always.

## The on-chain ids

Deliberately not tabulated here — they rotate, and a table in a README rots
silently. Read them from the source that cannot:

- **ar.io program ids** — the `@ar.io/sdk` exports (`ARIO_*_PROGRAM_ID`). The
  `kind:5096` whitelist is assembled from them at runtime in
  `src/gas-station-handler.ts`.
- **The connector's settlement addresses** — the live `kind:10032` announce, or
  `GET /ilp/identity` on a running node.
- **What this deployment pins** — `deploy/connector.toml.template`, which is the
  only place in this repo that hardcodes an address, because it is a
  deployment, not documentation.

TOON has **no mainnet deployment**. Everything here is devnet or testnet.

## How this fits together

The store is one repo of the **TOON Protocol** — pay-to-write Nostr over
Interledger.

- **[connector](https://github.com/toon-protocol/connector)** — the payment
  engine that runs in front of this. Claim validation lives there and only
  there.
- **[toon-meta](https://github.com/toon-protocol/toon-meta)** — shared docs,
  agent skills, and the canonical project context.

This repo publishes no npm package. It is a container:
`ghcr.io/toon-protocol/store`.
