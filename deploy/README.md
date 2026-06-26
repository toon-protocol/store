# store deploy — the Arweave store behind the TOON connector (payment proxy)

The production-faithful deployment of this store: the **connector (payment proxy,
"nginx for payments")** runs in front of the **payment-oblivious Arweave
store**. The connector monetizes the kind:5094 blob-storage job via
**RouteTermination** (the same model as the relay deploy), reverse-proxying a
plain `POST /store` to the store backend. Settlement runs against the **shared
live devnet**. **TLS is terminated by the deployment environment** (no Caddy
here).

```
payer ──paid POST /ilp──▶ connector ──paid job (POST /store)──▶ store :3300  (store backend; PRIVATE)
                            (terminates payment)                  └─ uploads blob to Arweave, returns {txId}
```

The connector's config is **baked into the `store-connector` image** (see
`Dockerfile` — `FROM ghcr.io/toon-protocol/connector` + `COPY connector.yaml`).
The store app image (`ghcr.io/toon-protocol/store`) is published separately and
serves the payment-oblivious `POST /store` backend that the connector
reverse-proxies to (RouteTermination).

## Files

| file                 | purpose                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `Dockerfile`         | `store-connector` image: pinned connector + baked `connector.yaml`                      |
| `connector.yaml`     | connector config (route `g.connector.store` → `http://store:3300`), devnet RPC baked in |
| `docker-compose.yml` | connector (payment proxy) + store (`POST /store` backend); only the edge `:3000` public|
| `.env.example`       | copy to `.env`; `STORE_NOSTR_SECRET_KEY` (required) + `TOON_MNEMONIC` + Arweave wallet   |

## Images

| image                                       | what it is                                                  |
| ------------------------------------------- | ----------------------------------------------------------- |
| `ghcr.io/toon-protocol/store`               | the normal store app (built by `publish-store-image.yml`)   |
| `ghcr.io/toon-protocol/store-connector`     | connector + this repo's `connector.yaml` baked in           |

The `store-connector` image bakes a **pinned** connector (`CONNECTOR_TAG`,
default `3.24.2`) so the config schema and the HTTP-envelope contract are frozen
against a known connector. The image's own version tracks this repo's release;
bump `CONNECTOR_TAG` deliberately to adopt a newer connector.

## Drop-in steps

1. **Set identities + wallet.**

   ```bash
   cp .env.example .env
   # STORE_NOSTR_SECRET_KEY is REQUIRED (the store won't boot without it):
   #   openssl rand -hex 32   → paste into STORE_NOSTR_SECRET_KEY
   # STORE_ARWEAVE_JWK_B64 is optional (empty → ephemeral free-tier, ≤100KB uploads).
   # TOON_MNEMONIC is optional (empty → pre-funded anvil account-0 devnet fallback).
   ```

   If you set `TOON_MNEMONIC`, also set `routes[].settlementAddresses.evm` in
   `connector.yaml` to the EVM address the connector prints at boot.

2. **Bring it up.**

   ```bash
   docker compose up --build -d      # builds store-connector locally; pulls the store app image
   docker compose ps                 # only :3000 (edge) is host-bound
   docker compose logs -f connector  # watch it register the route + chain provider
   ```

   Production: pin `STORE_CONNECTOR_IMAGE` to a published tag and run
   `docker compose up -d` (no `--build`).

## Verify the paid round-trip

Use the connector repo's store acceptance probe against this compose (run from
the **connector repo root** — it needs the repo + native `libsql`):

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 \
CONNECTOR_ILP_URL=http://localhost:3000/ilp \
EVM_RPC_URL=https://evm-rpc.devnet.toonprotocol.dev \
FAUCET_URL=https://faucet.devnet.toonprotocol.dev \
STORE_PROBE_URL=http://localhost:3300/store \
  npx ts-node --project packages/connector/tsconfig.json \
    scripts/app/ci-acceptance-probe-store.ts
```

It funds a fresh wallet from the devnet faucet, opens an on-chain USDC channel
toward the connector, signs a per-packet claim, and asserts: a paid `POST /ilp`
carrying a signed kind:5094 event → FULFILL whose body is the store's
`{ txId }`; an unpaid `POST /ilp` → REJECT; and the store backend (`:3300`) is
NOT publicly reachable. The ephemeral free-tier returns a real Arweave tx id for
≤100KB blobs without a funded wallet. (Against a public edge, point the URLs at
the env's HTTPS hostnames instead of `localhost`.)

## Out-of-band discovery (kind:10032 self-announce — remote/paid)

This store connector publishes a fresh `kind:10032` `IlpPeerInfo` announcement
describing its **own** `g.proxy.store` route (settlement address
`0x1f4E12…`) so a client holding **only the genesis seed** discovers the store
route out of band — instead of relying on it being advertised only by the apex.
This is the store-side half of
[toon-protocol/store#22](https://github.com/toon-protocol/store/issues/22)
(apex half: [relay#37](https://github.com/toon-protocol/relay/issues/37) /
[relay#39](https://github.com/toon-protocol/relay/pull/39)).

- The connector publishes the event **through its own routing** by addressing
  `announceTo` (an ILP route). Unlike the apex (which terminates its own
  `g.proxy.relay` and announces **free/locally**), the store box does **not** front
  the relay, so `announceTo: g.proxy.relay` resolves to a **forwarded** route (the
  outbound `g.proxy.relay → relay-connector` route in `connector.yaml`). The publish
  therefore takes the **REMOTE / PAID** branch: the store box **pays the apex** over
  its existing store↔apex settlement channel to store its own peer-info announcement
  on the relay. **This costs a small paid write on every refresh and needs the store
  box's funded channel to the apex.**
- The amount sent is `selfAnnounce.announcePrice` (`'2000'`). The apex's
  `g.proxy.relay` terminate price is `1000`, but the store box deducts its own
  `connectorFeePercentage` (0.1% = `floor(amount/1000)`) when it forwards the write,
  so `'1000'` would deliver only `999` and underpay — `'2000'` delivers `1998 ≥ 1000`
  (see the `connector.yaml` comment).
- It signs with its **NIP-06 key derived from `TOON_MNEMONIC`** (the settlement
  identity; no new secret). The announcement CONTENT carries route hints
  `{ publish: g.proxy.relay, store: g.proxy.store }`.
- It **refreshes before the NIP-40 expiration lapses** (`refreshIntervalSecs` →
  TTL = 2×), so the announcement is continuously fresh while the node is up.
- Config lives in `connector.yaml`'s `selfAnnounce` block. **It REQUIRES a connector
  image that includes [toon-protocol/connector#265](https://github.com/toon-protocol/connector/pull/265)** —
  bump `CONNECTOR_TAG` (`.env` / `Dockerfile`) to a release carrying it; older images
  ignore the block and the store box will not self-announce.

Verify it's live (after redeploying against a connector that supports it):

```bash
# Query the apex relay's free read WS for the store box's announcement:
npx ts-node -e 'import {SimplePool} from "nostr-tools";const p=new SimplePool();p.querySync(["wss://relay-ws.devnet.toonprotocol.dev"],{kinds:[10032]}).then(e=>{console.log(e);process.exit(0)})'
# Expect a fresh, UNEXPIRED kind:10032 from the store box whose content carries
# routes {publish,store} and settlement address 0x1f4E12…
```

## Privacy invariant

- **store `:3300` (store job backend) is never host-published** — the only way in
  is a paid `POST /ilp` to the connector. Enforcement is by construction
  (`expose`, not `ports`).
- **store `:3400` (health), connector `:8080` / admin `:8081` are never
  host-published.**
- The only host-bound port is the edge **`:3000`** — fronted by the
  environment's TLS terminator.
