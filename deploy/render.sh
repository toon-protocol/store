#!/usr/bin/env bash
# Render the files that carry deployment-specific values.
#
#   connector.toml.template   -> connector.toml            (paths, no secrets)
#   .env OPERATOR_BEARER_TOKEN-> operator-bearer.token     (0600 — a secret)
#   .env OPERATOR_WRITE_KEY   -> operator-write.keys       (0600 — public keys)
#   nginx/node.conf.template  -> nginx/conf.d/node.conf
#
# Every output is gitignored. Edit the templates.
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

# The connector template carries no placeholder any more: the operator
# credentials moved out into the two files written below, and everything else
# in it is a literal. Copying keeps the template/rendered split, so the file
# the box runs is still an output nobody edits in place.
cp connector.toml.template connector.toml

# ── The operator surface's two credentials ───────────────────────────────────
# The connector reads them from files, so connector.toml names paths and holds
# no credential of its own. Same two .env variables as before.
#
#   operator-bearer.token   the shared secret that gates operator READS
#   operator-write.keys     the PUBLIC halves allowed to sign operator WRITES,
#                           one per line; `#` starts a comment
printf '%s\n' "${OPERATOR_BEARER_TOKEN}" > operator-bearer.token
{
  echo "# Public keys allowed to sign operator writes, one per line."
  echo "# Rendered from OPERATOR_WRITE_KEY in .env by ./render.sh."
  printf '%s\n' "${OPERATOR_WRITE_KEY}"
} > operator-write.keys

# None of these may be world-readable — but the connector container runs as uid
# 10001, and a root-owned 0600 file is unreadable to it ("failed to read config
# file: Permission denied", then a restart loop). Hand them to that uid rather
# than widening the mode. connector.toml is only paths now, so 0600 on it is
# belt-and-braces; the other two really are secrets.
chmod 600 connector.toml operator-bearer.token operator-write.keys
if [ "$(id -u)" = 0 ]; then
  chown "${CONNECTOR_UID:-10001}:${CONNECTOR_UID:-10001}" \
    connector.toml operator-bearer.token operator-write.keys
else
  echo "note: not running as root, so the rendered files stay owned by $(id -un)." >&2
  echo "      The connector container runs as uid 10001 and will not be able to" >&2
  echo "      read them. Fine for a local render; re-run as root on the box." >&2
fi

mkdir -p nginx/conf.d
envsubst '${DOMAIN} ${CERT_NAME}' \
  < nginx/node.conf.template > nginx/conf.d/node.conf

echo "rendered connector.toml, the operator credential files (0600) and"
echo "  nginx/conf.d/node.conf for ${DOMAIN}"
echo "  certificate lineage: ${CERT_NAME}"
