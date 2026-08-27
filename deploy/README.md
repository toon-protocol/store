# Running the store box

This directory is the whole deployment. Everything the TOON devnet store box
runs is here: the payment proxy, the job backend, TLS, discovery and unattended
updates. `./bootstrap.sh` on a fresh Ubuntu host is the entire install.

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

   announce ──▶ publishes kind:10032 so clients can discover the above
   certbot  ──▶ renews the certificate
   watchtower ▶ recreates connector, store and announce when their tag moves
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
`proxy.ario.<your-domain>` and `dvm.<your-domain>` — and four key files.

**1. Clone and configure.**

```bash
git clone https://github.com/toon-protocol/store /root/store
cd /root/store/deploy
cp .env.example .env
$EDITOR .env          # every variable is documented in the file
```

**2. Generate the key material.** Four files, all `0600`, none of them ever
committed:

```bash
openssl rand -hex 32 > signer.key             # this node's ILP identity
openssl rand -hex 32 > settlement.key         # the EVM settlement key
openssl rand -hex 32 > settlement-solana.key  # the Solana settlement key
openssl rand -hex 32 > apex-store.secret      # the shared secret for the relay peering
chmod 600 *.key *.secret
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
docker compose logs announce --tail 20               # "[announce] OK -- g.toon.ario published"
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
| `connector`, `announce` | `ghcr.io/toon-protocol/connector:rust-release` | a **supervised promotion** in the connector repo, never automatically |

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
./render.sh && docker compose restart connector announce
```

The two must restart together: they share one config file and one binary
version, and the parser rejects unknown keys, so a newer config against an
older binary is a refuse-to-start.

## Make it yours

Most of `connector.toml.template` describes any app behind any connector. The
part that is specific to the TOON devnet is fenced under **"THIS DEPLOYMENT"**
at the bottom of the file — the relay peering, its payment channel, and the
announce. Replace that block, then change three things above it:

```toml
[[routes]]
prefix      = "g.example.myapp"          # the ILP address clients pay
handler_url = "http://myapp:8080/jobs"   # your backend; the path is literal
price       = 1000                       # smallest unit of the settlement token
```

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

## When the fleet moves past this tag

`connector.toml.template` is written for `:rust-release` as promoted today.
Two things change when the fleet promotes past connector#1165 and #1017, and
both are refuse-to-start failures if they land in the wrong order:

| Now | After |
|---|---|
| `[announce]` section + the `announce` container | `[node]` section; delete the container — the one-shot `connector announce` verb is gone and `GET /ilp` serves the self-description |
| `[operator] bearer_token` / `write_keys` inline | `bearer_token_file` / `write_keys_file` pointing at mounted files |

Land the config first, then move the tag. `src/deploy-bundle-guard.test.ts`
asserts the current shape, so flip those two assertions in the same commit and
CI will tell you if the bundle and the tag ever disagree.
