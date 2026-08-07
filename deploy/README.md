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
`Dockerfile` — `FROM ghcr.io/toon-protocol/connector` + `COPY connector.toml`).
The store app image (`ghcr.io/toon-protocol/store`) is published separately and
serves the payment-oblivious `POST /store` backend that the connector
reverse-proxies to (RouteTermination).

> **This bundle runs the Rust connector** (connector#755). It used to run the
> TypeScript node pinned at `3.28.0`, reading a `connector.yaml`. The TOON devnet
> cut over to the Rust connector on 2026-08-04 and stopped both TypeScript
> containers, so that pin points at a node nobody runs. See
> [Migrating from `3.28.0`](#migrating-from-3280) if you have an existing `.env`.

## Files

| file                 | purpose                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `Dockerfile`         | `store-connector` image: pinned Rust connector + baked `connector.toml`                   |
| `connector.toml`     | connector config (route `g.toon.ario` → `http://store:3300/store`), devnet RPC baked in   |
| `docker-compose.yml` | connector (payment proxy) + store (`POST /store` backend); only the edge `:3000` public   |
| `.env.example`       | copy to `.env`; `STORE_NOSTR_SECRET_KEY` (required) + Arweave wallet + image pins         |

## Images

| image                                   | what it is                                                |
| --------------------------------------- | --------------------------------------------------------- |
| `ghcr.io/toon-protocol/store`           | the normal store app (built by `publish-store-image.yml`) |
| `ghcr.io/toon-protocol/store-connector` | connector + this repo's `connector.toml` baked in         |

The `store-connector` image bakes a **pinned** connector (`CONNECTOR_TAG`,
default `rust-sha-440eab7`) so the config schema is frozen against a known
connector. The image's own version tracks this repo's release; bump
`CONNECTOR_TAG` deliberately to adopt a newer connector.

**Read the tag carefully.** The `connector` package carries two different
programs under one name. `rust-sha-<short>` and `rust-main` are the Rust
connector, which reads `connector.toml`. Plain semver tags (`3.28.0`) and
`latest` are the **retired** TypeScript node, which reads `connector.yaml` and
will not start on this bundle's config. Always pin an exact `rust-sha-`, never
the floating `rust-main`: the parser is `deny_unknown_fields` and startup is
fail-closed, so a schema drift under you is a refuse-to-start.

## Drop-in steps

1. **Generate the connector's two keys.** These are files, not environment
   variables — there is no env layer on the Rust connector, and no
   `TOON_MNEMONIC`.

   ```bash
   # This node's ILP signing identity (ADR 0012). Holds no money. Fresh random
   # material per box — it must NOT collide with any other node's.
   openssl rand -hex 32 > signer.key

   # The settlement identity. This one spends real testnet value and is what
   # clients open their payment channels AGAINST, so derive it from a seed you
   # can reproduce rather than from `openssl rand`. The TOON fleet uses NIP-06
   # m/44'/1237'/0'/0/0 — the NOSTR coin type, NOT the standard m/44'/60'.
   # Deriving at m/44'/60' yields a valid address no channel was ever opened
   # against, and a node that cannot resolve a single one.
   #   ...derive it, then:
   # printf '%s' "<64 hex chars>" > settlement.key

   chmod 600 signer.key settlement.key
   sudo chown 10001:10001 signer.key settlement.key   # the image runs as uid 10001
   ```

   Verify the derived settlement address **before** the first `up -d`. Both
   files are gitignored (`deploy/*.key`).

   > A bind-mounted file keeps its **host** ownership inside the container, so a
   > root-owned `0600` key is unreadable to uid 10001 and the container
   > restart-loops on "Permission denied". The `chown` is the fix — do not reach
   > for `chmod 644`.

2. **Set the store's identity + wallet.**

   ```bash
   cp .env.example .env
   # STORE_NOSTR_SECRET_KEY is REQUIRED (the store won't boot without it):
   #   openssl rand -hex 32   → paste into STORE_NOSTR_SECRET_KEY
   # STORE_ARWEAVE_JWK_B64 is optional (empty → ephemeral free-tier, ≤100KB uploads).
   ```

3. **Bring it up.**

   ```bash
   docker compose up --build -d      # builds store-connector locally; pulls the store app image
   docker compose ps                 # only :3000 (edge) is host-bound
   docker compose logs -f connector  # watch it load the routes + connect to settlement
   ```

   Production: pin `STORE_CONNECTOR_IMAGE` to a published tag and run
   `docker compose up -d` (no `--build`).

   **Startup is fail-closed.** A missing key file, an unwritable `/app/state`, or
   a settlement registry that will not resolve the token is `exit 1` with the
   reason — never a degraded run. If the connector exits immediately, the log
   line names which of those it was.

## Verify the paid round-trip

Use the connector repo's store acceptance probe against this compose (run from
the **connector repo root** — it needs the repo + native `libsql`):

```bash
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

## Migrating from `3.28.0`

If you have an existing `.env` and a running stack, these are the breaking
differences. None of them fail quietly — a leftover YAML-ism is a config-load
error by name, because the TOML parser is `deny_unknown_fields`.

| was                                                | now                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `deploy/connector.yaml`                            | `deploy/connector.toml` — a different config language             |
| `CONNECTOR_TAG=3.28.0`                             | `CONNECTOR_TAG=rust-sha-…`; a semver tag is the retired node      |
| `TOON_MNEMONIC` derives the settlement key at boot | derive it yourself; mount `settlement.key`                        |
| `CONFIG_FILE=/app/config/connector.yaml`           | nothing — the image's `CMD` already names the path                |
| `NODE_TLS_REJECT_UNAUTHORIZED=0`                   | no equivalent; use an RPC with a real chain of trust              |
| connector health `:8080`, admin `:8081`            | one port: `:3000` carries the edge, the operator surface, metrics |
| route prefix `g.proxy.store`                       | `g.toon.ario` (+ `g.toon.relay.ario`, `g.toon.store` aliases)     |
| `selfAnnounce` block (kind:10032)                  | **no always-on equivalent — see below**                           |
| an outbound `g.proxy.relay` forward route          | gone — it existed only to carry the announce                      |
| replay watermarks lived in process memory          | `state_dir = "/app/state"`, on a named volume                     |

That last row is the one worth dwelling on: without a durable claim journal, a
restart resets every channel's replay watermark, a channel with no watermark
accepts any nonce, and every claim a payer already spent becomes free service
again (connector#605). That is why `docker-compose.yml` gained a
`connector_state` named volume.

### The kind:10032 self-announce did not survive as an always-on timer

The old `connector.yaml` carried a `selfAnnounce` block, and on this box it was
the interesting one: because the store box does not front a relay, its announce
took the **remote/paid** branch — it paid the apex over its own settlement
channel, on every refresh, to publish its own `kind:10032` peer info
([store#22](https://github.com/toon-protocol/store/issues/22),
[relay#37](https://github.com/toon-protocol/relay/issues/37)). That is where the
`announcePrice = 2000` figure came from, and why an outbound forward route to
the apex existed at all.

That specific shape is gone for good: there is no config field that makes the
Rust connector pay a refresh on a timer, so this bundle's `connector.toml`
carries no forward route and no `announcePrice` to carry it. What replaced it
is not "nothing" but a different verb: the Rust connector has an `[announce]`
config section and a one-shot `connector announce` operator command (see the
pinned tag's `docs/operators/announcing-a-node.md` in the connector repo) that
publishes a single `kind:10032` event, paid for out of this node's own
`[settlement.evm]` identity like any other client write. This bundle's
`connector.toml` doesn't configure `[announce]`, so out of the box this store
still publishes nothing — but the reason is "not wired up here," not "the
connector cannot do it." On the TOON devnet, self-announce for this box's own
route currently runs through a separate announcer sidecar instead of
`connector announce`; either is a config/operator choice now, not a capability
gap.

## Privacy invariant

- **store `:3300` (store job backend) is never host-published** — the only way in
  is a paid `POST /ilp` to the connector. Enforcement is by construction
  (`expose`, not `ports`).
- **store `:3400` (health) is never host-published.**
- **The connector publishes exactly one port, `:3000`.** There is no separate
  health or admin port to leak. The operator surface that shares `:3000` is
  omitted from `connector.toml` entirely, so there is nothing there to
  authenticate against — read that file's `[operator]` comment before enabling it
  on a **baked** config.
- The only host-bound port is the edge **`:3000`** — fronted by the
  environment's TLS terminator.
