# store

**A paid Arweave blob store, and a worked example of putting any app behind the
TOON connector.**

```
   client ──── pays ────▶ connector ──── POST /store ────▶ store ──▶ Arweave
                          g.toon.store    (payment already      returns a
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
prefix      = "g.toon.store"                # the ILP address clients pay
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

`kind:5094` is always on. `kind:5095` registers only when its credential is
present, so a default deployment serves blob storage and nothing else.

| Kind | What it does | Enabled by | Source |
|---|---|---|---|
| **5094** | Arweave blob storage | always on | [`entrypoint-store.ts`](./src/entrypoint-store.ts) |
| **5095** | ArNS brokered name buy (`op=buy`) | `ARNS_DVM_SOLANA_SECRET_KEY` | [`arns-buy-handler.ts`](./src/arns-buy-handler.ts) |
| **5095** | ANT spawn composition (`op=prepare`) | `ARNS_DVM_SOLANA_SECRET_KEY` | [`arns-ant-prepare.ts`](./src/arns-ant-prepare.ts) |

### kind:5095 has two ops

`op=buy` is the original job and stays the default, so a caller that sends no
`op` tag is unaffected. It wants a `processId`: the MPL Core asset pubkey of an
ANT the client already owns.

Which was the problem. Spawning an ANT costs ~0.012 SOL of rent, and a TOON
client holds ILP credit, not SOL — so `kind:5095` shipped with a precondition
none of its callers could satisfy. `op=prepare` closes that. The store composes
the spawn transaction, the **client** signs it, and the **gas station**
([`g.toon.gas`](https://github.com/toon-protocol/gas-station)) pays for it and
broadcasts it. Three parties, one transaction, and this store touches no key.

```
1. client -> gas station  quote (no draft)      -> feePayer
2. client -> store        op=prepare            -> unsigned draft transaction
3. client -> gas station  quote (with draft)    -> quoteId, recentBlockhash, maxLamports
4. client -> store        op=prepare + blockhash-> the final transaction
5. client                 signs mint + owner    (in place; never recompile)
6. client -> gas station  execute               -> co-signed, broadcast
7. client -> store        op=buy processId=mint -> the name is yours
```

Steps 2 and 4 are the same call — `recentBlockhash` is optional exactly so one
implementation serves both. Two rounds are needed because the gas station
requires a *signed* draft to price the job (an unpriced quote caps at 1,000,000
lamports, and this transaction costs ~12.2M), and then requires the executed
transaction to carry the blockhash *it* chose. A client that can patch 32 bytes
into a serialized message can skip step 4.

The transaction the store composes:

```
[0] ComputeBudget::SetComputeUnitLimit(400_000)
[1] System::Transfer   feePayer -> owner, 9_242_880 lamports
[2] MPL Core CreateV1  asset=mint  authority=owner  payer=feePayer
[3] ario_ant::initialize  owner=owner
```

Instruction [1] is not a convenience. `ario_ant::initialize` has no payer
account — its `owner` is the writable signer, so the ANT's three state PDAs are
debited from the *client*. `CreateV1` does have a payer slot, so the asset's
rent comes straight off the gas wallet. A zero-SOL client can only cover the
PDA half if the fee payer hands it the lamports in the same atomic transaction.

The ACL bootstrap is deliberately left out: ~61.4M lamports against a 20M
per-job ceiling, and its instructions put the payer in an ar.io slot the gas
station refuses outright. The ANT resolves without it — it just will not appear
in "ANTs I own" registry lookups until the client bootstraps it with its own
SOL, and that registry is an eventually-consistent index, not truth.

### The gas stations moved out

`kind:5096` (Solana fee-payer co-sign) and `kind:5098` (EVM ERC-2771 relaying)
now live in **[toon-protocol/gas-station](https://github.com/toon-protocol/gas-station)**.

They were never storage. This node sells bytes it bought in bulk from Turbo; a
gas station spends its own money, at whatever a chain charges that second, on a
transaction a stranger wrote. That is a different security posture, a different
thing to fund and monitor, and — as it turned out — a much smaller box. Sharing
an image meant every store deploy was also a gas-station deploy, and the two
had no reason to move together.

A client that was paying `g.toon.store` for a gas job wants `g.toon.gas` now.

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

`kind:5095`'s credential is listed in
[`deploy/.env.example`](./deploy/.env.example), which documents it and how to
generate it. It is treated as a secret: never logged, and deleted from
`process.env` after boot.

## Deploy it

[`deploy/`](./deploy) is the real thing — the six containers the TOON devnet
store box actually runs, not a sketch of them. `./bootstrap.sh` on a fresh
Ubuntu host is the entire install.

Updates are unattended: a green merge to `main` publishes
`ghcr.io/toon-protocol/store:release`, and Watchtower recreates the container
within about a minute.

**The connector half moves differently, and also on its own.** It is an
immutable pin in `deploy/docker-compose.yml` — a `rust-sha-` build or a
`rust-<release handle>` — so Watchtower has nothing to follow for it. What
moves it is a connector **release**: one human dispatch in the connector repo,
after which
[`.github/workflows/adopt-connector-release.yml`](.github/workflows/adopt-connector-release.yml)
notices within half an hour, **renders this bundle's `connector.toml` and boots
the candidate image against it**, and only then opens and auto-merges the pin
bump. A build that refused a key by name or newly required one fails that gate
and no pull request appears — connector ADR 0041's Decision 1, asked at the one
moment the candidate and this node's config are in front of the same machine.

Once merged the box applies it within five minutes:
[`deploy/auto-apply.sh`](deploy/auto-apply.sh) on a systemd timer
fast-forwards `main`, re-renders, brings the compose project up and requires
the connector to come back **healthy**. It is pull-based deliberately — no CI
job anywhere holds SSH into a node (connector ADR 0068) — and it refuses to
touch a box whose working tree is dirty. Install it once per box; see
[`deploy/README.md`](deploy/README.md) § "Following connector releases".

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

- **ar.io program ids** — the `@ar.io/sdk` exports (`ARIO_*_PROGRAM_ID`), which
  `src/arns-buy-handler.ts` resolves at runtime.
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
