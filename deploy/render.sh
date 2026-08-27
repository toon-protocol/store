#!/usr/bin/env bash
# Render the two config files that carry deployment-specific values.
#
#   connector.toml.template   -> connector.toml       (0600 — holds a secret)
#   nginx/node.conf.template  -> nginx/conf.d/node.conf
#
# Both outputs are gitignored. Edit the templates.
#
# envsubst is given an EXPLICIT variable list. Without one it would substitute
# every $NAME it sees, and both templates contain nginx variables ($host,
# $backend, $binary_remote_addr) that must survive to the rendered file.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing .env — copy .env.example and fill it in." >&2; exit 1; }
set -a; . ./.env; set +a

: "${DOMAIN:?set DOMAIN in .env}"
: "${OPERATOR_BEARER_TOKEN:?set OPERATOR_BEARER_TOKEN in .env (openssl rand -hex 32)}"
: "${OPERATOR_WRITE_KEY:?set OPERATOR_WRITE_KEY in .env (the nostr pubkey allowed to sign operator writes)}"
: "${CERT_NAME:=proxy.ario.${DOMAIN}}"
export CERT_NAME

envsubst '${OPERATOR_BEARER_TOKEN} ${OPERATOR_WRITE_KEY}' \
  < connector.toml.template > connector.toml

# This file carries the operator bearer token inline, so it must not be
# world-readable — but the connector container runs as uid 10001, and a
# root-owned 0600 file is unreadable to it ("failed to read config file:
# Permission denied", then a restart loop). Hand it to that uid rather than
# widening the mode.
chmod 600 connector.toml
if [ "$(id -u)" = 0 ]; then
  chown "${CONNECTOR_UID:-10001}:${CONNECTOR_UID:-10001}" connector.toml
else
  echo "note: not running as root, so connector.toml stays owned by $(id -un)." >&2
  echo "      The connector container runs as uid 10001 and will not be able to" >&2
  echo "      read it. Fine for a local render; re-run as root on the box." >&2
fi

mkdir -p nginx/conf.d
envsubst '${DOMAIN} ${CERT_NAME}' \
  < nginx/node.conf.template > nginx/conf.d/node.conf

echo "rendered connector.toml (0600) and nginx/conf.d/node.conf for ${DOMAIN}"
echo "  certificate lineage: ${CERT_NAME}"
