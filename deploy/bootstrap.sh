#!/usr/bin/env bash
# Bring the store box up from a fresh Ubuntu host. Idempotent — re-running it
# reconciles the box rather than rebuilding it.
#
#   ./bootstrap.sh
#
# Expects .env and the four key files to already be in this directory; see
# README.md § "Standing one up". Everything it installs is listed here, and it
# makes no changes outside this directory, ufw, docker and journald.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing .env — copy .env.example and fill it in." >&2; exit 1; }
for f in signer.key settlement.key settlement-solana.key apex-store.secret; do
  [ -f "$f" ] || { echo "Missing $f — see README.md § Standing one up." >&2; exit 1; }
done

echo "==> [1/6] Firewall"
# Only SSH, HTTP (for ACME) and HTTPS. Note that docker publishes ports by
# writing iptables rules that BYPASS ufw, so this protects the host but not a
# container that publishes on 0.0.0.0 — which is why docker-compose.yml binds
# the connector to 127.0.0.1.
apt-get update -y
apt-get install -y ufw curl gettext-base openssl
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp  comment 'SSH'
ufw allow 80/tcp  comment 'HTTP (ACME)'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable

echo "==> [2/6] Docker"
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

echo "==> [3/6] Cap the journal"
# A small box should not lose its disk to logs.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/00-cap.conf
systemctl restart systemd-journald || true

echo "==> [4/6] Render config"
./render.sh

echo "==> [5/6] Pull and start"
docker compose pull --ignore-pull-failures
docker compose up -d

echo "==> [6/6] TLS"
./init-letsencrypt.sh

set -a; . ./.env; set +a
echo
echo "store box up."
echo "  paid ILP edge : https://proxy.ario.${DOMAIN}/ilp"
echo "  identity      : https://proxy.ario.${DOMAIN}/ilp/identity"
echo "  health        : https://dvm.${DOMAIN}/health"
