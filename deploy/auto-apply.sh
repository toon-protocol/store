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
# An empty list is an answer, so grep coming up empty must not trip set -e.
advertised_addresses() {
  sed -n 's/^[[:space:]]*addresses[[:space:]]*=[[:space:]]*\[\(.*\)\].*/\1/p' "$1" \
    | grep -o 'g\.[A-Za-z0-9._-]*' | sort -u || true
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
# The rendered file is also BIND-MOUNTED, and `up -d` recreates a container on
# a changed image or definition, never on changed bytes behind a bind mount --
# so a rendered change is on disk but not live until the connector rereads it
# (store#124: an addresses change sat inactive for hours behind a green apply).
# Fingerprint the file around render.sh to know whether it changed; a missing
# pre-render file counts as changed, and WHY it changed does not matter. The
# pre-render address list is kept too, so a verification failure below can say
# which era of the config the connector is still serving.
SUM_BEFORE=none
ADDRESSES_BEFORE=""
if [ -f connector.toml ]; then
  SUM_BEFORE=$(sha256sum connector.toml | awk '{print $1}')
  ADDRESSES_BEFORE=$(advertised_addresses connector.toml)
fi
[ -x ./render.sh ] && ./render.sh
SUM_AFTER=none
[ -f connector.toml ] && SUM_AFTER=$(sha256sum connector.toml | awk '{print $1}')

# The overlay set this box actually runs. Keep in step with README.md. This box
# runs the base file only; the relay box adds a Watchtower overlay, and this
# picks that up on its own if the file is ever added here.
COMPOSE=(-f docker-compose.yml)
[ -f docker-compose.watchtower.yml ] && COMPOSE+=(-f docker-compose.watchtower.yml)

docker compose "${COMPOSE[@]}" pull
docker compose "${COMPOSE[@]}" up -d

# Activate what was rendered. `up -d` above will not have recreated the
# connector for a content-only config change, so bounce it -- and ONLY it:
# nothing else changed, and nginx in particular must outlive the others.
if [ "$SUM_AFTER" != "$SUM_BEFORE" ]; then
  echo "connector.toml changed on render; restarting the connector to activate it"
  docker compose "${COMPOSE[@]}" restart connector
fi

# The connector must come back healthy. Every node bundle defines a healthcheck
# on it (GET /ilp/identity), so this is a real answer rather than "the container
# exists".
CONNECTOR=$(docker compose "${COMPOSE[@]}" ps -q connector)
for _ in $(seq 1 40); do
  STATUS=$(docker inspect "$CONNECTOR" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  [ "$STATUS" = healthy ] && break
  sleep 3
done

if [ "${STATUS:-unknown}" != healthy ]; then
  echo "FAILED: the connector is '$STATUS' after applying ${REMOTE:0:7}."
  docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
  exit 1
fi

# Healthy proves the connector is SERVING; it does not prove it serves the
# config just rendered. Ask the running connector for its self-description
# (GET /ilp, unauthenticated, on the loopback-published port from
# docker-compose.yml) and hold its advertised addresses against the rendered
# [node] list -- both directions, so a stale extra name fails too. Same guard
# as render.sh above: a bundle whose config is committed whole renders
# nothing, and the checksums have already said nothing changed.
if [ -x ./render.sh ]; then
  WANT=$(advertised_addresses connector.toml)
  ILP_PORT=$(sed -n "s/.*'127\.0\.0\.1:\([0-9]*\):[0-9]*'.*/\1/p" docker-compose.yml | head -n 1)
  SERVED=$(curl -fsS "http://127.0.0.1:${ILP_PORT:-4000}/ilp" || true)
  # Only the ilpAddresses array: the body also lists routes[].prefix, and this
  # box deliberately TERMINATES a name it does not advertise, so grepping the
  # whole body would fail every healthy apply.
  GOT=$(printf '%s' "$SERVED" \
    | sed -n 's/.*"ilpAddresses":\[\([^]]*\)\].*/\1/p' \
    | grep -o 'g\.[A-Za-z0-9._-]*' | sort -u || true)
  if [ "$GOT" != "$WANT" ]; then
    echo "FAILED: the running connector does not serve the rendered config."
    if [ "$GOT" = "$ADDRESSES_BEFORE" ] && [ "$WANT" != "$ADDRESSES_BEFORE" ]; then
      echo "It still advertises the PRE-render addresses: the rendered change never"
      echo "activated (the connector was not restarted, or came back on the old file)."
    else
      echo "The old config is gone, and what is served still does not match."
    fi
    echo "rendered [node].addresses:"
    printf '%s\n' "$WANT" | sed 's/^/  /'
    echo "addresses served by GET /ilp:"
    printf '%s\n' "$GOT" | sed 's/^/  /'
    docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
    exit 1
  fi
fi

echo "applied ${REMOTE:0:7}; connector healthy."
