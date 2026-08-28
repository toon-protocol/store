# Running the store box

This directory is the whole deployment. Everything the TOON devnet store box
runs is here: the payment proxy, the job backend, TLS and unattended updates. `./bootstrap.sh` on a fresh Ubuntu host is the entire install.

```
                         ┌──────────────────────────────────────┐
   client ──── :443 ────▶│ nginx          the only public port  │
   (pays)                └───────┬──────────────────────┬───────┘
                                 │                      │
                    proxy.ario.* │                      │ dvm.*
                                 ▼                      ▼
                    ┌────────────────────┐    ┌──────────────────┐
                    │ connector   :4000  │    │ store      :3400 │
                    │ meters & settles   │    │ health           │
                    └─────────┬──────────┘    └──────────────────┘
                              │ POST /store (payment already proven)
                              ▼
                    ┌────────────────────┐
                    │ store       :3300  │──▶ Arweave (via Turbo)
                    └────────────────────┘

   certbot  ──▶ renews the certificate
   watchtower ▶ recreates connector and store when their tag moves

   Discovery is GET /ilp on the connector, which serves the [node]
   self-description — there is no announce sidecar.
```

## Files

| File | What it is |
|---|---|
| `docker-compose.yml` | The six containers above. The only file that names an image tag. |
| `connector.toml.template` | The payment proxy's config: what this node sells, at what price, and how it settles. Rendered to `connector.toml`. |
| `nginx/node.conf.template` | The TLS edge. Rendered to `nginx/conf.d/node.conf`. |
| `render.sh` | Fills both templates in from `.env`. |
| `bootstrap.sh` | Fresh-host install: firewall, docker, render, start, TLS. |
| `init-letsencrypt.sh` | Issues or reuses the certificate. Idempotent. |
| `.env.example` | Every variable, with what it is and how to generate it. |

`.env`, the rendered `connector.toml`, `nginx/conf.d/` and all key material are
gitignored. **Only templates are committed.**

## Standing one up

**Before you start** you need a host, two DNS A-records pointing at it —
`proxy.ario.<your-domain>` and `dvm.<your-domain>` — and three key files.

**1. Clone and configure.**

```bash
git clone https://github.com/toon-protocol/store /root/store
cd /root/store/deploy
cp .env.example .env
$EDITOR .env          # every variable is documented in the file
```

**2. Generate the key material.** Three files, all `0600`, none of them ever
committed:

```bash
openssl rand -hex 32 > signer.key             # this node's ILP identity
openssl rand -hex 32 > settlement.key         # the EVM settlement key
openssl rand -hex 32 > settlement-solana.key  # the Solana settlement key
chmod 600 *.key
```

The signer key is the identity `GET /ilp/identity` answers with and that every
client seals its packets to. Changing it makes this node a different node.

**3. Bring it up.**

```bash
./bootstrap.sh
```

That renders the config, starts the six containers, and requests a
certificate. It is idempotent — re-run it to reconcile a box.

**4. Go to production TLS.** `bootstrap.sh` starts on Let's Encrypt *staging*
so a DNS mistake does not burn the real rate limit. Once
`https://dvm.<domain>/health` answers (with a certificate warning), set
`LETSENCRYPT_STAGING=0` in `.env` and re-run `./init-letsencrypt.sh`.

## Checking it works

```bash
docker compose ps                                    # six services, store healthy
curl https://dvm.<domain>/health                     # {"status":"ok","handlerKinds":[5094],...}
curl https://proxy.ario.<domain>/ilp/identity        # the signer pubkey clients seal to
curl https://proxy.ario.<domain>/ilp                  # the [node] self-description clients discover
```

To prove the paid path end to end, publish a blob with a TOON client pointed at
`https://proxy.ario.<domain>/ilp`. The client pays 0.001 USDC, the connector
settles it, and the store answers with an Arweave transaction id.

## How updates arrive

Nothing here is deployed by hand. Watchtower polls once a minute and recreates
a container when the tag it follows changes digest.

| Container | Follows | Moves when |
|---|---|---|
| `store` | `ghcr.io/toon-protocol/store:release` | every green merge to `main` in this repo |
| `connector` | `ghcr.io/toon-protocol/connector:rust-release` | a **supervised promotion** in the connector repo, never automatically |

The difference is deliberate. The store's own image is this repo's to move; the
connector's is the fleet's, and auto-moving it on green main once pushed
unvalidated builds to two live boxes in about sixty seconds.

`nginx` and `certbot` deliberately carry no Watchtower label. nginx holds the
resolver that lets every other container survive being recreated at a new
address, and certbot holds the renewal timer; neither should change because
an upstream base image was pushed.

**To roll back**, pin the immutable tag and bring it up:

```bash
docker compose up -d --no-deps \
  -e STORE_IMAGE=ghcr.io/toon-protocol/store:sha-<known-good> store
```

Every superseded build stays pullable from GHCR by its own `sha-` /
`rust-sha-` tag.

**Config changes need a restart.** The connector reads `connector.toml` once at
startup and holds it for the process lifetime — a bind mount is not a reload,
and there is no environment-variable layer. After editing:

```bash
./render.sh && docker compose restart connector
```

`connector.toml` and the connector's tag move together: the config uses a
`{ base, per_kib }` price and a `[node]` section, and an older connector can
parse neither. A config from the future against an older binary is a
refuse-to-start, not a degraded run.

## Make it yours

Most of `connector.toml.template` describes any app behind any connector. The
part specific to the TOON devnet is fenced under **"THIS DEPLOYMENT"** at the
bottom — the `[node]` addresses and public URLs. Replace that block with your
own, then change the route above it:

```toml
[[routes]]
prefix      = "g.example.myapp"              # the ILP address clients pay
handler_url = "http://myapp:8080/jobs"       # your backend; the path is literal
price       = { base = 1000, per_kib = 10 }  # or a flat integer, if size doesn't matter
```

Point the settlement sections at whatever chain and token you settle in, and
generate your own `signer.key` — that key *is* your node's identity.

Point `docker-compose.yml`'s `store` service at your own image, keep the
health endpoint so compose can tell when it is ready, and the rest of this
directory works unchanged.

## Privacy invariant

The store backend is **payment-oblivious**: by the time a request reaches
`POST /store` the payment is already proven, and the backend contains no ILP,
claim or settlement logic. It never sees a payer's channel, balance or claim
history. Keep it that way — that separation is what lets the store be
restarted, rebuilt and rolled back without touching anything that holds money.

### `ports:` bypasses ufw

Docker manages its own iptables rules ahead of ufw's, so a container published
with `ports:` is reachable from the internet **regardless of what `ufw status`
shows**. A ufw rule allowing only loopback does **not** make a
`ports:`-published container private.

This bundle therefore keeps every published port host-IP-prefixed — the
connector is `127.0.0.1:4000:4000`, and the store publishes nothing at all —
so the paid edge is reachable only through this box's own reverse proxy rather
than by trusting the firewall to hide a `0.0.0.0` bind.
`src/deploy-bundle-guard.test.ts` fails CI if that ever regresses.

## The routing table

One prefix, terminated here:

| Prefix | Where it goes | Client pays here |
|---|---|---|
| `g.toon.store` | terminates → `store:3300/store` → Arweave | `base 1000 + 10/KiB` |

A route is a prefix plus **exactly one** of `handler_url` (terminate) or
`peer_id` (forward), and a price is required on both branches. Longest prefix
wins.

### Peering with the relay

The relay is the fleet's write ingress. Peering with it means a client already
connected here can pay **this** edge to reach it, rather than opening a second
channel of its own.

The peering is bound to a **channel**, not a shared secret — ADR 0060 deleted
the shared secret outright, and the role is proved by the channel binding plus
a verified claim signature. One channel serves both roles, which CF-22
explicitly permits and is the deployed shape here:

- **`[[peer_channels]]`** — what the relay's claims are judged against, and the
  key whose signature is accepted on them.
- **`[[pay_channels]]`** — what this node pays *from*. Every forwarded PREPARE
  carries a covering claim on it (ADR 0042).

`0x53689fa2…` on Base Sepolia, funded from both sides. It is the same channel
this box already used to pay for publishing its announce.

**Pricing a forwarded route** (ADR 0028): it is priced at *this* client edge.
The relay charges `1` for `g.toon.relay`, this node retains its peering `fee`
of `1`, so a client pays `2` here. The fee attaches to the **peering**, not the
route (ADR 0061) — carrying a packet is the same work whichever prefix was
addressed.

**The relay exposes no peer carriage of its own** (`peerCarriages: []` in its
`GET /ilp`), so this node pays it as an ordinary client, which is what it
already did to publish its announce. Nothing on the relay has to change for
this to work. If the relay later sets `peer_expose`, the `[[peer_channels]]`
row above is already what it needs to judge our claims.

## Pricing

The route bills a **schedule over payload length** (ADR 0065), not a flat
figure — an upload can be any size, and one price for a 1 KB object and a
50 MB one is the wrong shape for a blob store:

```toml
price = { base = 1000, per_kib = 10 }   # base + 10 per KiB, rounded up
```

| Upload | Charged | ≈ |
|---|---|---|
| 1 KB | 1,010 | $0.0010 |
| 100 KB | 2,000 | $0.0020 |
| 1 MB | 11,240 | $0.0112 |
| 10 MB | 103,400 | $0.1034 |
| 50 MB | 513,000 | $0.5130 |

That is about **$10.7/GB**, which tracks what permanent Arweave storage costs
plus a margin. Units are the settlement token's smallest unit; USDC has 6
decimals, so 1,000,000 is $1.

A flat integer (`price = 1000`) is still valid if you want one — it is exactly
`{ base = 1000, per_kib = 0 }`.

**One thing to know:** the store separately advertises `basePricePerByte` on
`/health` (from `FEE_PER_JOB`, default 10). That figure is **informational**
— the connector is what actually charges, using the schedule above. The two
have never agreed, and the advertised field counts per *byte* where the route
counts per *KiB*, so it cannot express this schedule exactly. Treat `/health`
as a hint, and this route as the price.

## This bundle and the connector tag move together

`connector.toml.template` is written for `:rust-release` as promoted today,
which carries ADR 0065, 0050 and 0060. Three things here will not load on an
older connector, each a refuse-to-start rather than a degraded run:

| This bundle uses | An older connector |
|---|---|
| `price = { base, per_kib }` | parses only a bare integer — TOML parse error |
| `[node]` | wanted `[announce]`, and a `connector announce` sidecar with it |
| no `[[peers]] credential` | — (the reverse: a *newer* connector refuses `credential` by name) |

So a rollback below the promoted build needs the config rolled back with it.
`src/deploy-bundle-guard.test.ts` asserts the current shape, so CI tells you
if the bundle and the tag ever disagree.
