# store

The TOON Protocol **store** — NIP-90 **kind:5094** Arweave blob storage, plus **kind:5095** ArNS, which carries two ops — `op=buy`, the brokered name purchase (`src/arns-buy-handler.ts`), gated by `ARNS_DVM_SOLANA_SECRET_KEY` because it spends, and `op=prepare`, which composes an unsigned ANT-spawn transaction the client signs and the gas station pays to broadcast (`src/arns-ant-prepare.ts`) and needs no credential at all. `op` defaults to `buy`. The gas-station kinds (5096 Solana, 5098 EVM) moved to **[toon-protocol/gas-station](https://github.com/toon-protocol/gas-station)**. Built from `Dockerfile.store` over `src/entrypoint-store.ts`, which wraps `@toon-protocol/sdk`'s `createArweaveDvmHandler`: upload the blob to Arweave via Turbo, return the tx id. This is a **container, not an npm package** (`@toon-protocol/store`, kept private). It runs as a payment-oblivious `POST /store` backend (`src/store-backend.ts`) behind the connector, which is the front-of-app payment proxy and reverse-proxies to it (RouteTermination).

`deploy/` **is** the store box, not a sketch of it: five containers (nginx/TLS, connector, store, certbot, Watchtower) that the TOON devnet store box actually runs, installed by `deploy/bootstrap.sh`. The connector image is an immutable `ghcr.io/toon-protocol/connector:rust-sha-<short>` pin (bumped by commit together with the literal in the guard test — connector ADR 0068; nothing moves `:rust-release` any more) with `connector.toml` bind-mounted — there is no derived `store-connector` image any more. Config files are rendered from committed `*.template` files by `deploy/render.sh`; the rendered output and all key material are gitignored. `src/deploy-bundle-guard.test.ts` asserts the bundle stays consistent.

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos.

## Build
This builds a Docker image, not an npm package:
```
pnpm install
pnpm build            # esbuild bundle of the entrypoint
docker build -f Dockerfile.store -t toon-store .
```
Image-publish workflow: `publish-store-image.yml` (the store app → `ghcr.io/toon-protocol/store`, moving the `:release` tag Watchtower follows on every green `main`).

## Agent skills

### Issue tracker
Issues live in this repo's GitHub Issues (`toon-protocol/store`, via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels
The five canonical triage labels, names unchanged. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context: this file and `README.md`; the shared vocabulary and ADRs live in `toon-protocol/connector`. See `docs/agents/domain.md`.

## The AFK factory
`ready-for-agent` is the queue. `.github/workflows/agent-implement.yml` finds the issues an agent can start (`.sandcastle/ready-issues.ts`: not a spec, no open blocker, no open PR), and `.sandcastle/agent-implement-issue.ts` runs `/mattpocock-skills:implement`, then `/mattpocock-skills:code-review` in a second session, then the gate, then opens a PR labelled `ready-for-human`. The gate (`.sandcastle/run-gate.ts`) is `ci.yml`'s `build` job commands (`pnpm build`, `typecheck`, `lint`, `test`), and `.sandcastle/agent-factory.test.ts` fails if the two drift. `.sandcastle/Dockerfile` is the sandbox image; `Dockerfile.store` is the published store image. Keep them separate.

## Cross-repo dependencies
- Consumes `@toon-protocol/{core,sdk}` from **npm** (pinned semver) — the Arweave handler lives in `sdk`.
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo. The DVM receives ILP packets from the connector via HTTP and trusts they were already validated; **claim validation lives ONLY in the connector.**
