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

## Privacy invariant

- **store `:3300` (store job backend) is never host-published** — the only way in
  is a paid `POST /ilp` to the connector. Enforcement is by construction
  (`expose`, not `ports`).
- **store `:3400` (health), connector `:8080` / admin `:8081` are never
  host-published.**
- The only host-bound port is the edge **`:3000`** — fronted by the
  environment's TLS terminator.
