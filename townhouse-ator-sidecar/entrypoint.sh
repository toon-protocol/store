#!/bin/sh
# Townhouse ATOR sidecar entrypoint.
#
# Runs anon directly (no SDK) with a hand-written torrc that includes
# HiddenServiceDir + HiddenServicePort. The HS forwards inbound traffic to
# a sibling container (the apex connector) reached via Docker DNS / Akash
# service-DNS.
#
# This bypasses the upstream SDK gap (anyone-client v1.1.3 ignores HS opts).
#
# Environment (all optional with sensible defaults — except HS_SECRET_KEY_B64
# which is REQUIRED for a known-in-advance .anyone address):
#   HS_SECRET_KEY_B64    base64-encoded hs_ed25519_secret_key (no default).
#                        scripts/townhouse-hs-init.sh generates the keypair
#                        locally and injects this. If absent, anon generates
#                        a fresh keypair (the published .anyone address won't
#                        match the operator's pre-known one).
#   HS_PORT              (default 3000) - HS port advertised on .anyone.
#   HS_TARGET_HOST       (default connector) - DNS name to forward HS traffic to.
#   HS_TARGET_PORT       (default 3000) - port on HS_TARGET_HOST.
#   SOCKS_PORT           (default 9050) - SOCKS5 port for outbound BTP from
#                        the connector. Bound on 0.0.0.0 so the sibling
#                        connector container can reach it via DNS.
#   NICKNAME             (default townhouse-hs) - log prefix.
set -eu

NICKNAME=${NICKNAME:-townhouse-hs}
HS_PORT=${HS_PORT:-3000}
# Default to 127.0.0.1 — safe for keygen-only runs (the init script in
# scripts/townhouse-hs-init.sh runs the sidecar briefly to capture the
# keypair, then discards the container). Real deploys override this to
# point at the connector service via Docker / Akash DNS.
HS_TARGET_HOST=${HS_TARGET_HOST:-127.0.0.1}
HS_TARGET_PORT=${HS_TARGET_PORT:-3000}
SOCKS_PORT=${SOCKS_PORT:-9050}
# DNS resolve budget. 30s was enough on docker-compose where service DNS
# is registered immediately, but on Akash multi-service deployments the
# connector pod's DNS entry can take 1-3 minutes to materialize while the
# scheduler pulls 5+ images concurrently. Default to 180s; override via env.
HS_TARGET_RESOLVE_TIMEOUT=${HS_TARGET_RESOLVE_TIMEOUT:-180}

# anon's HiddenServicePort directive does NOT support hostnames in the
# target — only IP:port. Resolve HS_TARGET_HOST to an IP via getent before
# writing the torrc. If it's already an IP, getent returns it unchanged.
resolve_target_ip() {
  local host="$1"
  case "$host" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) printf '%s' "$host"; return 0 ;;
  esac
  # Retry — Docker/Akash service-DNS isn't always immediately populated
  # when the sidecar boots before its sibling. Budget controlled by
  # HS_TARGET_RESOLVE_TIMEOUT (default 180s, configurable via env).
  local waited=0 ip=
  while [ "$waited" -lt "$HS_TARGET_RESOLVE_TIMEOUT" ]; do
    ip="$(getent hosts "$host" 2>/dev/null | awk '{print $1; exit}')"
    if [ -n "$ip" ]; then
      printf '%s' "$ip"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "[sidecar ${NICKNAME}] ERROR: could not resolve HS_TARGET_HOST=$host after ${waited}s" >&2
  return 1
}

HS_TARGET_IP="$(resolve_target_ip "$HS_TARGET_HOST")" || exit 1
echo "[sidecar ${NICKNAME}] HS forward target: $HS_TARGET_HOST → $HS_TARGET_IP:$HS_TARGET_PORT"

mkdir -p /var/lib/anon/hs
chmod 0700 /var/lib/anon/hs

# Seed the v3 hidden-service keypair if provided. anon detects existing keys
# under HiddenServiceDir and reuses them — no regeneration. The secret key
# MUST be mode 0600 or anon refuses to load it.
if [ -n "${HS_SECRET_KEY_B64:-}" ]; then
  echo "[sidecar ${NICKNAME}] seeding hs_ed25519_secret_key from HS_SECRET_KEY_B64"
  printf '%s' "${HS_SECRET_KEY_B64}" | base64 -d > /var/lib/anon/hs/hs_ed25519_secret_key
  chmod 0600 /var/lib/anon/hs/hs_ed25519_secret_key
  # Ownership: anon's strict check requires the data dir owner = running user.
  # We run as root here; chown to be explicit.
  chown -R root:root /var/lib/anon
else
  echo "[sidecar ${NICKNAME}] WARNING: HS_SECRET_KEY_B64 unset — anon will generate"
  echo "[sidecar ${NICKNAME}] WARNING: a fresh keypair. The published .anyone address"
  echo "[sidecar ${NICKNAME}] WARNING: will NOT match any pre-known operator address."
  echo "[sidecar ${NICKNAME}] WARNING: Run scripts/townhouse-hs-init.sh first to seed."
fi

# Generate torrc. Public Anyone network, single hidden service forwarding
# to a sibling container by name. SOCKS5 bound to 0.0.0.0 so the connector
# container can reach it via Docker/Akash DNS as `socks5h://ator-sidecar:9050`.
RC=/etc/anon/torrc
cat > "$RC" <<EOF
AgreeToTerms 1
DataDirectory /var/lib/anon
SOCKSPort 0.0.0.0:${SOCKS_PORT}
SOCKSPolicy accept *
HiddenServiceDir /var/lib/anon/hs
HiddenServicePort ${HS_PORT} ${HS_TARGET_IP}:${HS_TARGET_PORT}
Log notice stdout
RunAsDaemon 0
EOF

echo "[sidecar ${NICKNAME}] generated torrc:"
echo "============================================================"
cat "$RC"
echo "============================================================"

# Watcher: log the published .anyone hostname once anon writes it, so
# operators can `docker logs` and see the address without exec-ing in.
(
  HOSTFILE=/var/lib/anon/hs/hostname
  while [ ! -s "$HOSTFILE" ]; do sleep 2; done
  echo "[sidecar ${NICKNAME}] HS hostname: $(cat "$HOSTFILE" | tr -d '\n')"
) &

# Run anon in foreground. Container exit follows anon exit.
exec anon -f "$RC"
