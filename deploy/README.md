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
| `docker-compose.shared-edge.yml` | The overlay that runs this box behind the devnet host's shared edge instead of its own nginx (infra#24). Off by default. § "Running behind the shared edge". |
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

## Running behind the shared edge

The devnet is moving onto one Linode, shared by the relay, store, gas
station, workload gateway and faucet nodes, behind one Caddy **edge** that
owns ports 80 and 443 (infra#24, infra ADR 0001). This box keeps its own
connector, keys and hostnames — only its own TLS front (`nginx` + `certbot`)
goes away.

Turn it on with two lines in `.env`, the same pattern as the provider's
`docker-compose.hidden.yml`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.shared-edge.yml
```

`docker compose` reads `COMPOSE_FILE` from `.env` itself, so every `docker
compose` command run in this directory — `auto-apply.sh`'s included — sees
the merged stack; a `.env` with no `COMPOSE_FILE` line runs
`docker-compose.yml` alone, exactly as before this overlay existed.
`bootstrap.sh` and `init-letsencrypt.sh` detect it the same way and skip
issuing or renewing a certificate for this box.

`docker-compose.shared-edge.yml`:

- disables `nginx`, `certbot` and `watchtower` (`profiles: [disabled]` — a
  profile nothing ever activates). Watchtower is not missed:
  `auto-apply.sh` already pulls the pinned `store`/`connector` images
  unattended.
- joins `connector` and `store` to the **external** Docker network
  `edge-store` (one of five per-node networks the infra#24 edge project
  creates — `edge-relay`, `edge-store`, `edge-gas`, `edge-gateway`,
  `edge-faucet` — with Caddy alone joining all five) under stable aliases.
  Each node on its own network, rather than one flat network everyone
  shares, is what keeps this box's connector unreachable from every other
  node on the host — only the edge itself can reach in.
- adds a `mem_limit` to every service, sized for the confirmed 1 GB Linode
  nanode host (961 MB total, ~350 MB used by OS/Docker before any node
  starts). `connector` (64m) and `store` (256m, with `NODE_OPTIONS` also
  overridden to `--max-old-space-size=192`) are based on idle `docker stats`
  measured 2026-09-25 on production Linodes (connector 2 MB, store 39 MB
  idle; infra#25 step 2). `nginx`, `certbot` and `watchtower` stay disabled
  and keep their original provisional limits (32m, 32m, 64m).
- moves the connector's loopback publish to **`127.0.0.1:4003:4000`**
  (`ports: !override`, so it is the *only* publish once the overlay is on).
  Every node bundle's own `docker-compose.yml` publishes its connector on
  `127.0.0.1:4000`, and those collide once several nodes share one host — a
  real outage (infra#25). The container side stays 4000; only the host side
  moves, to this node's own assignment:

  | Node | Host loopback port |
  |---|---|
  | relay | `127.0.0.1:3000` |
  | gateway | `127.0.0.1:4001` |
  | gas-station | `127.0.0.1:4002` |
  | store | `127.0.0.1:4003` |

  `auto-apply.sh` already asks `docker compose port connector 4000` for
  whatever port is actually published, across every file `COMPOSE_FILE`
  names, rather than assuming 4000 (connector#1337) — it needed no further
  change for this.

### The alias:port table infra#24's edge config is written from

Worked out from `nginx/node.conf.template` — what nginx does today for each
hostname, which the edge's config has to replicate:

| Hostname | Edge upstream | Container:port | What it serves |
|---|---|---|---|
| `proxy.ario.${DOMAIN}` | `store-proxy:4000` | `connector:4000` | the paid ILP edge |
| `dvm.${DOMAIN}` | `store-dvm:3400` | `store:3400` | health (`BLS_PORT`) |

### What nginx does beyond plain proxying — the edge must replicate this

A storage node's uploads make the body-size cap and the timeout matter more
than they would for a typical proxy:

- **`client_max_body_size 4m`** on both hostnames. A single `POST /store`
  upload above this is refused with `413` before it reaches the connector or
  the store at all.
- **`proxy_read_timeout 1h`** on both hostnames — a large upload settling
  through the connector on to Turbo can legitimately run long; the edge's
  default timeout (Caddy's is far shorter) would sever it mid-upload.
- **Rate limiting**: `limit_req_zone … rate=200r/s` keyed on the client IP,
  applied with `burst=400 nodelay` on every location.
- **CORS on `GET /ilp/identity` only**: `Access-Control-Allow-Origin:
  https://proxy.${DOMAIN}` plus `Vary: Origin`. No other location sets a CORS
  header.
- **`location ^~ /admin { return 404; }`** on both hostnames — nothing behind
  either upstream exposes an admin surface publicly, and nginx refuses to
  even proxy the path.
- **`X-Forwarded-For` and `X-Forwarded-Proto: https`** are set on every
  proxied request, and the `Upgrade`/`Connection` headers are forwarded so a
  WebSocket upgrade survives the hop (this box has no WebSocket route today,
  but the header pass-through is unconditional in the template).
- **A resolver instead of a config-parse-time DNS lookup**
  (`resolver 127.0.0.11 valid=10s`) is nginx's own fix for Watchtower
  recreating a container at a new address; it has no equivalent to replicate
  on the edge side, since the edge reaches this box's containers by the
  stable `edge-store` network alias, not by an address that moves.

### What must not change without the overlay

`docker-compose.yml` itself is untouched by this issue: a `.env` with no
`COMPOSE_FILE` line runs exactly the six-container bundle described at the
top of this file, `nginx` still owns 80 and 443, and nothing carries a
`mem_limit` or an `edge-store` network membership. `deploy/docker-compose.shared-edge.test.ts`
guards both shapes against the real `docker compose config`.

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
`src/deploy-bundle-guard.test.ts` fails CI if that ever regresses. Under the
shared-edge overlay this moves to `127.0.0.1:4003:4000` — see "Running behind
the shared edge", above.

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
re-renders, runs `docker compose up -d`, restarts the connector whenever its
rendered inputs changed **or** the running connector serves addresses that
disagree with the render, and requires it to come back **healthy** and to
prove (via `GET /ilp`) that the rendered config is what is actually served. It is pull-based deliberately — no CI job anywhere holds SSH
into a node, which is the posture connector ADR 0068 settled — and it refuses
to touch a box whose working tree is dirty, so a human mid-operation is never
overwritten.

### How updates arrive: a failed render or apply is retried, never sat on

**A render or apply failure is retried, and reported, forever — never
silently sat on (TOON_Network#164, porting TOON_Network#160).** Before this,
`auto-apply.sh` fast-forwarded the checkout and only then rendered and
applied — so a `render.sh`, pull or health-check failure after a good
fast-forward left the box on the new commit with the OLD rendered config and
containers, and the NEXT run's `git fetch` brought back nothing new, so
`LOCAL = REMOTE` alone read as "nothing to do" and it exited 0 silently: one
red apply, then green forever on an unverified box (this file used to say so
in a comment; it no longer needs to).

The fix is `deploy/.applied` (gitignored). Once render, the pull, `up -d`,
the health wait and the activation check have all succeeded, `auto-apply.sh`
records the commit it just applied there. The *next* run compares `HEAD` to
`.applied`, not to whatever `git fetch` just brought back — so a failure
anywhere in that chain leaves `.applied` naming the OLD commit, and the very
next timer tick treats that as work to do even though the fetch brings back
nothing new. It fails the same way, by the same name, on every run —
`systemctl status` and the journal keep showing it — until whatever failed
(most often a newly-required `.env` variable; `.env.example` lists every one)
is fixed and a run finally succeeds and rewrites `.applied`.

On a box with no `deploy/.applied` yet — an existing box's first run under
this check, or one where the file was lost — that absence is read as
*needing* an apply, not as "must already be applied": the run re-renders,
re-verifies and writes `.applied` once everything reports healthy. That run
is a harmless no-op if the box was already caught up (nothing on disk or in
the running connector has anything to change), which is why treating a
missing file this way, rather than having `bootstrap.sh` write it, is the
safer of the two: the box's first-ever apply IS this script's first run, and
it should prove itself exactly like every later one does.

| File | What it is |
|---|---|
| `../.github/workflows/adopt-connector-release.yml` | Watches the connector repo for a cut release, renders this bundle's `connector.toml` and boots the candidate against it, then opens (and auto-merges) the pin bump. |
| `auto-apply.sh` | On the box: fast-forwards `main`, re-renders, `docker compose up -d`, activates the render with a connector restart when needed, requires the connector to come back healthy serving the rendered config, and retries a failed render or apply on every run until it is fixed. |
| `toon-auto-apply-store.service` / `.timer` | The systemd pair that runs it every five minutes. Install once, below. |

The split is deliberate: the workflow decides **what** to run and proves it
accepts this node's config first; the box decides **when** to apply, by
pulling. Nothing outside this box can make this box deploy.

The unit pair is named per node (`toon-auto-apply-store.*`, shared contract
v2) rather than `toon-auto-apply.*`, because the shared-edge host runs five
of these side by side — a name common to every node could only mean one
timer, one service and one lock file for all of them, when each node needs
its own. The lock path in `auto-apply.sh` follows the same rule
(`/var/lock/toon-auto-apply-store.lock`).

Install the timer once per box:

```bash
sudo cp /root/store/deploy/toon-auto-apply-store.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now toon-auto-apply-store.timer
systemctl list-timers toon-auto-apply-store.timer     # when it next fires
journalctl -u toon-auto-apply-store.service -n 50     # what it last did
systemctl start toon-auto-apply-store.service         # run one now, by hand
```

**Migrating an existing box (infra#25 cutover).** A single-node Linode
already running the old `toon-auto-apply.timer` keeps working unmodified —
it points at the same `auto-apply.sh` path, which has not moved, so nothing
breaks if it is left alone. Once that node moves onto the shared host, do
the one-time swap so its unit name no longer collides with any other node's:

```bash
sudo systemctl disable --now toon-auto-apply.timer
sudo rm /etc/systemd/system/toon-auto-apply.{service,timer}
sudo cp /root/store/deploy/toon-auto-apply-store.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now toon-auto-apply-store.timer
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
