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
[ -x ./render.sh ] && ./render.sh

# The overlay set this box actually runs. Keep in step with README.md. This box
# runs the base file only; the relay box adds a Watchtower overlay, and this
# picks that up on its own if the file is ever added here.
COMPOSE=(-f docker-compose.yml)
[ -f docker-compose.watchtower.yml ] && COMPOSE+=(-f docker-compose.watchtower.yml)

docker compose "${COMPOSE[@]}" pull
docker compose "${COMPOSE[@]}" up -d

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

echo "applied ${REMOTE:0:7}; connector healthy."
