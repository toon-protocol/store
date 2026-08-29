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
   watchtower ▶ recreates the store when its tag moves; the connector is an
                immutable pin, bumped by commit and picked up on `up -d`

   Discovery is GET /ilp on the connector, which serves the [node]
   self-description — there is no announce sidecar.
```

## Files

| File | What it is |
|---|---|
| `docker-compose.yml` | The six containers above. The only file that names an image tag. |
| `connector.toml.template` | The payment proxy's config: what this node sells, at what price, and how it settles. Rendered to `connector.toml`. It names key and credential PATHS only, so it holds no secret. |
| `nginx/node.conf.template` | The TLS edge. Rendered to `nginx/conf.d/node.conf`. |
| `render.sh` | Fills the templates in from `.env`, and writes the operator surface's two credential files — `operator-bearer.token` and `operator-write.keys` — from `OPERATOR_BEARER_TOKEN` and `OPERATOR_WRITE_KEY`. |
| `bootstrap.sh` | Fresh-host install: firewall, docker, render, start, TLS. |
| `init-letsencrypt.sh` | Issues or reuses the certificate. Idempotent. |
| `.env.example` | Every variable, with what it is and how to generate it. |

`.env`, the rendered `connector.toml`, `operator-bearer.token`,
`operator-write.keys`, `nginx/conf.d/` and all key material are gitignored.
**Only templates are committed.**

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
docker compose ps                                    # six services, connector and store healthy
# the connector's healthcheck is GET /ilp/identity — 200 only once it is
# serving AND has read its signer key, which "Up" alone does not prove
curl https://dvm.<domain>/health                     # {"status":"ok","handlerKinds":[5094],...}
curl https://proxy.ario.<domain>/ilp/identity        # the signer pubkey clients seal to
curl https://proxy.ario.<domain>/ilp                  # the [node] self-description clients discover
```

To prove the paid path end to end, publish a blob with a TOON client pointed at
`https://proxy.ario.<domain>/ilp`. The client pays 0.001 USDC, the connector
settles it, and the store answers with an Arweave transaction id.

## How updates arrive

The store's image is deployed unattended. Watchtower polls once a minute and
recreates a container when the tag it follows changes digest.

| Container | Follows | Moves when |
|---|---|---|
| `store` | `ghcr.io/toon-protocol/store:release` | every green merge to `main` in this repo |
| `connector` | an immutable pin — a `rust-sha-<short>` build or a `rust-<release handle>` | when a connector release is adopted: a reviewed commit here, opened and merged automatically, then applied by this box's own timer (see "Following connector releases") |

The difference is deliberate. The store's own image is this repo's to move; the
connector's is pinned to one immutable build, because nothing moves the old
`:rust-release` pointer any more (connector ADR 0068 — a node repository pins
the connector it runs, in one place, guarded there). Watchtower still carries
the label so a bumped pin is picked up on the next `docker compose up -d`.

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

`connector.toml` and the connector's pin move together: the config uses a
`{ base, per_kib }` price and a `[node]` section, and an older connector can
parse neither. A config from the future against an older binary is a
refuse-to-start, not a degraded run. See § "Bumping the connector pin".

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

Two prefixes, both terminated here, one advertised:

| Prefix | Where it goes | Client pays here | In `GET /ilp` |
|---|---|---|---|
| `g.toon.store` | terminates → `store:3300/store` → Arweave | `base 1000 + 10/KiB` | yes |
| `g.toon.relay.store` | terminates → the same handler, same schedule | `base 1000 + 10/KiB` | **no** |

`g.toon.relay.store` is the **relay's** name for this service, beneath the
relay's own prefix. The relay routes to this box under it, and a forward copies
the destination through verbatim, so packets arrive wearing that name and need
a row here or they are refused at the door. Same handler and same schedule as
the row above — the connector refuses a config where one handler is reachable
at two prices.

It is terminated but **not advertised**: this box answers to the relay's name
because the relay sends under it, and does not claim a name from the relay's
prefix as one of its own. A client discovering this node reads back
`g.toon.store` and nothing else.

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

## Following connector releases

**A newer connector arrives on its own, from a release.** When the connector
repo cuts a release — one human dispatch, stamping an immutable
`ghcr.io/toon-protocol/connector:rust-<handle>` that nothing ever moves — this
repo notices within half an hour and opens the pin bump itself
([`../.github/workflows/adopt-connector-release.yml`](../.github/workflows/adopt-connector-release.yml)).

It is keyed to a **release**, not to every green `main` in the connector. That
dispatch is the human decision point, and following every green merge instead
is the shape that took the devnet dark in about sixty seconds when it was
tried (connector#990) and was reverted.

Before it opens anything it **renders this bundle's `connector.toml` from the
committed template the way this box does, boots the candidate image against
it, and requires the build to accept the file.** A build that refused a key by
name, renamed a field or newly required one fails there, and no pull request
appears. That is connector ADR 0041's Decision 1 — an image a box follows
unattended may only move to a build that still accepts the config that box
runs — asked at the one moment the candidate image and this node's config are
in front of the same machine. It used to be a tag move in the connector repo;
since ADR 0068 there is no tag move, so the moment is that pull request and
the gate lives with it.

Two outcomes count as acceptance: `connector listening`, and `failed to
construct the configured settlement backend` — the latter because config
validation happens strictly before backend construction, so reaching it means
the whole file parsed, and a CI runner holds no funded settlement key. `config
file ... is not valid` is the failure the gate exists to catch.

Once that PR merges, the box applies it within five minutes:
[`auto-apply.sh`](./auto-apply.sh) on a systemd timer fast-forwards `main`,
re-renders, runs `docker compose up -d`, and requires the connector to come
back **healthy**. It is pull-based deliberately — no CI job anywhere holds SSH
into a node, which is the posture connector ADR 0068 settled — and it refuses
to touch a box whose working tree is dirty, so a human mid-operation is never
overwritten.

| File | What it is |
|---|---|
| `../.github/workflows/adopt-connector-release.yml` | Watches the connector repo for a cut release, renders this bundle's `connector.toml` and boots the candidate against it, then opens (and auto-merges) the pin bump. |
| `auto-apply.sh` | On the box: fast-forwards `main`, re-renders, `docker compose up -d`, and requires the connector to come back healthy. |
| `toon-auto-apply.service` / `.timer` | The systemd pair that runs it every five minutes. Install once, below. |

The split is deliberate: the workflow decides **what** to run and proves it
accepts this node's config first; the box decides **when** to apply, by
pulling. Nothing outside this box can make this box deploy.

Install the timer once per box:

```bash
sudo cp /root/store/deploy/toon-auto-apply.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now toon-auto-apply.timer
systemctl list-timers toon-auto-apply.timer     # when it next fires
journalctl -u toon-auto-apply.service -n 50     # what it last did
systemctl start toon-auto-apply.service         # run one now, by hand
```

The pin is still the only place a connector build is named here, and it is
still immutable — a `rust-sha-` build or a `rust-<handle>` release, never a
moving tag. The config parser is `deny_unknown_fields` and startup is
fail-closed, which is exactly why the gate runs before the pin moves rather
than after.

## Bumping the connector pin

Usually you do not: § "Following connector releases" above does it for you,
gate and all. This is the manual path — a build between releases, or a
rollback.

`docker-compose.yml` pins the connector to one immutable `rust-sha-` build, and
`src/deploy-bundle-guard.test.ts` pins the same literal. To move:

1. Read the connector's release notes for schema changes. The parser is
   `deny_unknown_fields` and startup is fail-closed, so a key the new build
   refuses is a refuse-to-start, never a degraded run.
2. Change `connector.toml.template` first if the new build wants it, then the
   tag in `docker-compose.yml` and the test literal, in one commit. Boot the
   rendered config on the candidate image before opening the PR: `docker run
   --rm` it with throwaway key files mounted and look for `connector
   listening`.
3. On the box: `git pull && ./render.sh && docker compose up -d`.

To roll the connector back, pin the previous `rust-sha-` tag the same way.

`connector.toml.template` is written for the pinned build, which carries ADR
0065, 0050 and 0060. Three things here will not load on an older connector,
each a refuse-to-start rather than a degraded run:

| This bundle uses | An older connector |
|---|---|
| `price = { base, per_kib }` | parses only a bare integer — TOML parse error |
| `[node]` | wanted `[announce]`, and a `connector announce` sidecar with it |
| no `[[peers]] credential` | — (the reverse: a *newer* connector refuses `credential` by name) |

So a rollback below that needs the config rolled back with it.
`src/deploy-bundle-guard.test.ts` asserts the current shape and the pin, so CI
tells you if the bundle and the tag ever disagree.
