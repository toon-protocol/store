#!/usr/bin/env bash
#
# Apply what was merged. Run by systemd on a timer; see deploy/README.md.
#
# This is the box half of "the fleet follows connector releases". The repo half
# is .github/workflows/adopt-connector-release.yml, which opens and merges the
# pin bump after proving the candidate still accepts this node's config. This
# script's whole job is to notice that main moved and apply it.
#
# It is PULL-based on purpose. The alternative -- a CI job holding an SSH key
# into this box -- is the write path connector ADR 0068 deliberately removed,
# and putting it back in three repos' secrets is a wider blast radius than the
# tedium it saves. Nothing outside this box can make this box deploy.
#
# It refuses rather than guesses:
#   * a dirty working tree means a human is mid-operation here -- stop, loudly;
#   * only a fast-forward is applied, never a merge or a reset, so a box can
#     never end up on a tree nobody reviewed;
#   * after `up -d` the connector must reach `healthy`, or this exits non-zero
#     so `systemctl status` and the journal show it. A box that comes back
#     unhealthy is also picked up by the connector repo's fleet-health.yml,
#     which opens a needs:human issue.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_DIR="$REPO_DIR/deploy"
cd "$REPO_DIR"

# The [node] addresses a connector.toml advertises, one per line, sorted.
# Scoped to the [node] table (the sed range runs from `[node]` to the next
# table header), so an `addresses = [...]` under any other table can never
# leak into the comparison. Quoted-string extraction, not a g.* shape filter,
# so an address of any spelling counts. KNOWN LIMIT: the sed matches a
# single-line `addresses = [...]` only; a reformatted template parses EMPTY,
# which the caller below refuses loudly instead of letting the verification
# pass vacuously.
advertised_addresses() {
  sed -n '/^\[node\]/,/^[[:space:]]*\[/s/^[[:space:]]*addresses[[:space:]]*=[[:space:]]*\[\(.*\)\].*/\1/p' "$1" \
    | grep -o '"[^"]*"' | tr -d '"' | sort -u || true
}

# Every file render.sh writes that docker-compose.yml bind-mounts into the
# connector (plus the hand-placed key files, which ride along for free): a
# change to ANY of them needs a connector restart to become live, not just
# connector.toml -- a rotated OPERATOR_WRITE_KEY re-renders only
# operator-write.keys, and a revoked key that stays authorised is the same
# bug class as store#124, for a security-relevant file. Missing files are
# tolerated (first render) and count as a change once they appear.
fingerprint_connector_inputs() {
  { sha256sum \
      connector.toml \
      operator-bearer.token \
      operator-write.keys \
      signer.key \
      settlement.key \
      settlement-solana.key \
      2>/dev/null || true; } | sha256sum | awk '{print $1}'
}

# One apply at a time, and never one racing a human.
exec 9>/var/lock/toon-auto-apply.lock
flock -n 9 || { echo "another apply is already running; leaving it alone"; exit 0; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "REFUSING: the working tree at $REPO_DIR is dirty."
  echo "Someone is editing on the box. Commit, stash or discard it, then this resumes on its own."
  exit 1
fi

git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0   # nothing merged since last time; the quiet, common case
fi

echo "applying ${LOCAL:0:7} -> ${REMOTE:0:7}"
git merge --ff-only origin/main

cd "$DEPLOY_DIR"
# This bundle's connector.toml is RENDERED from connector.toml.template and
# .env, so a pulled template change is not live until render.sh has run. (The
# relay's config is committed whole and has no render.sh; the check is kept in
# all three copies so the script is the same file everywhere.) render.sh is
# also what chowns the rendered files to uid 10001 -- it must run as root, and
# systemd runs this as root.
#
# The rendered files are BIND-MOUNTED, and `up -d` recreates a container on
# a changed image or definition, never on changed bytes behind a bind mount --
# so a rendered change is on disk but not live until the connector rereads it
# (store#124: an addresses change sat inactive for hours behind a green apply).
# Fingerprint the connector's whole input set around render.sh; a missing
# pre-render file counts as changed, and WHY it changed does not matter.
#
# The fingerprint alone is NOT the restart decision. It compares this run's
# disk to this run's disk, which says nothing about what the RUNNING connector
# loaded -- the exact assumption store#124 was filed about. The decision below
# also asks the running connector what it serves and compares that to the
# render, so a box already sitting on a stale config self-heals on the next
# apply even when no file byte moved. "Next apply" means the next COMMIT to
# main: a run exits at the LOCAL=REMOTE gate above before reaching any of
# this, so on a quiet repo a stale box waits for the next merge, not the
# next timer tick.
SUM_BEFORE=$(fingerprint_connector_inputs)
[ -x ./render.sh ] && ./render.sh
SUM_AFTER=$(fingerprint_connector_inputs)

# The overlay set this box actually runs. Keep in step with README.md. This box
# runs the base file only; the relay box adds a Watchtower overlay, and this
# picks that up on its own if the file is ever added here.
COMPOSE=(-f docker-compose.yml)
[ -f docker-compose.watchtower.yml ] && COMPOSE+=(-f docker-compose.watchtower.yml)

# Captured before `up -d` so a recreation (image bump) is distinguishable: a
# recreated connector already booted on the just-rendered files and must not
# be bounced a second time for the same change.
CONNECTOR_BEFORE_UP=$(docker compose "${COMPOSE[@]}" ps -q connector || true)

docker compose "${COMPOSE[@]}" pull
docker compose "${COMPOSE[@]}" up -d

# The connector must reach `healthy`. Every node bundle defines a healthcheck
# on it (GET /ilp/identity), so this is a real answer rather than "the
# container exists". Docker resets Health.Status to `starting` on restart, so
# calling this right after a restart cannot read a stale `healthy`.
wait_connector_healthy() {
  local connector status
  connector=$(docker compose "${COMPOSE[@]}" ps -q connector)
  for _ in $(seq 1 40); do
    status=$(docker inspect "$connector" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
    [ "$status" = healthy ] && return 0
    sleep 3
  done
  echo "FAILED: the connector is '${status:-unknown}' after applying ${REMOTE:0:7}."
  docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
  return 1
}

wait_connector_healthy || exit 1

# Ask the RUNNING connector what it advertises (GET /ilp, unauthenticated, on
# the loopback-published port from docker-compose.yml). Only the ilpAddresses
# array: the body also lists routes[].prefix, and this box deliberately
# TERMINATES a name it does not advertise, so comparing anything wider would
# fail every healthy apply. The body is whitespace-stripped first so a
# pretty-printed answer parses the same as a compact one, and only the FIRST
# ilpAddresses occurrence is read -- the top-level one, ahead of any future
# nested peers[] entry.
#
# A curl failure is a FAILURE of this function (distinct exit), never an empty
# address list: an unreachable /ilp must be reported as unreachable, not as a
# config mismatch. The curl retries a few times first: a run that dies on one
# connection blip exits 1 once, and every later timer run exits 0 at the
# LOCAL=REMOTE gate -- one red apply, then green forever on an unverified box.
# Retries make that state need a real outage, not a blip.
# The port sed matches the single-quoted '127.0.0.1:N:M' publish rows and
# takes the first, which is the connector's -- the only loopback-published
# service in every node bundle. The 4000 fallback matches the committed file.
# `|| true` because under pipefail a sed that outruns head's one line dies on
# SIGPIPE and would abort the whole script as a bare exit 141.
ILP_PORT=$({ sed -n "s/.*'127\.0\.0\.1:\([0-9]*\):[0-9]*'.*/\1/p" docker-compose.yml | head -n 1; } || true)
ILP_PORT=${ILP_PORT:-4000}
served_ilp_addresses() {
  local body
  # --retry alone skips connection resets/refusals (it only covers timeouts
  # and 5xx); --retry-all-errors is what makes a nanode's blip retryable.
  body=$(curl -fsS --retry 3 --retry-delay 2 --retry-all-errors --max-time 10 \
    "http://127.0.0.1:${ILP_PORT}/ilp") || return 1
  printf '%s' "$body" | tr -d ' \t\r\n' \
    | grep -o '"ilpAddresses":\[[^]]*\]' | head -n 1 \
    | sed 's/^"ilpAddresses"://' \
    | grep -o '"[^"]*"' | tr -d '"' | sort -u || true
}

# Activate and verify what was rendered -- for the bundles that render. (A
# bundle whose config is committed whole has no render.sh and no rendered
# state to activate; its fingerprints cannot differ.)
if [ -x ./render.sh ]; then
  WANT=$(advertised_addresses connector.toml)
  if [ -z "$WANT" ]; then
    echo "FAILED: parsed no addresses out of the rendered connector.toml's [node] block."
    echo "The activation check below would pass vacuously; fix the template or the parser."
    exit 1
  fi

  if ! GOT=$(served_ilp_addresses); then
    echo "FAILED: GET /ilp on 127.0.0.1:${ILP_PORT} is unreachable while the connector reports healthy."
    docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
    exit 1
  fi

  # Restart when the rendered inputs changed (unless `up -d` already recreated
  # the container, which booted it on the new files), OR when the running
  # connector serves addresses that disagree with the render -- the store#124
  # state itself, which no byte-comparison of this run's disk can see.
  CONNECTOR_AFTER_UP=$(docker compose "${COMPOSE[@]}" ps -q connector)
  NEEDS_RESTART=0
  if [ "$SUM_AFTER" != "$SUM_BEFORE" ] && [ "$CONNECTOR_AFTER_UP" = "$CONNECTOR_BEFORE_UP" ]; then
    echo "the connector's rendered inputs changed; restarting it to activate them"
    NEEDS_RESTART=1
  fi
  if [ "$GOT" != "$WANT" ]; then
    echo "the running connector serves addresses that differ from the rendered config; restarting it"
    NEEDS_RESTART=1
  fi

  if [ "$NEEDS_RESTART" = 1 ]; then
    # Bounce the connector and ONLY it: nothing else changed, and nginx in
    # particular must outlive the others.
    docker compose "${COMPOSE[@]}" restart connector
    wait_connector_healthy || exit 1
    if ! GOT=$(served_ilp_addresses); then
      echo "FAILED: GET /ilp on 127.0.0.1:${ILP_PORT} is unreachable after restarting for activation."
      docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
      exit 1
    fi
  fi

  # Both directions, so a stale extra name fails too.
  if [ "$GOT" != "$WANT" ]; then
    echo "FAILED: the running connector does not serve the rendered config, even after restarting."
    echo "rendered [node].addresses:"
    printf '%s\n' "$WANT" | sed 's/^/  /'
    echo "addresses served by GET /ilp:"
    printf '%s\n' "$GOT" | sed 's/^/  /'
    docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
    exit 1
  fi
fi

echo "applied ${REMOTE:0:7}; connector healthy, rendered config verified live."
