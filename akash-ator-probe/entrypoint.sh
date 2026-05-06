#!/bin/sh
# ATOR-on-Akash probe entrypoint — no-ingress design.
#
# Architecture: this container runs anon as a hidden service ONLY. Nothing is
# externally reachable from the internet. The .anyone address IS the access
# mechanism — clients dial it through their own anon SOCKS5 proxy.
#
# Hostname discovery: we expect the operator to PRE-GENERATE the v3 keypair
# locally and inject the secret via HS_SECRET_KEY_B64. anon detects existing
# keys under /var/lib/anon/hs/ and reuses them, so the .anyone address is
# known before deploy. If HS_SECRET_KEY_B64 is unset, anon generates fresh
# keys (useful for one-off dev tests, useless for an Akash deploy where you
# can't see the resulting hostname without a wallet shell).
#
# Layout:
#   - anon (foreground): joins the public Anyone network, publishes a hidden
#     service on TARGET_PORT, forwards to 127.0.0.1:TARGET_PORT
#   - socat (background): listens on 127.0.0.1:TARGET_PORT and responds with
#     "PROBE-OK\n" — the round-trip target reached via .anyone
#
# Environment:
#   NICKNAME           (default: probe)        — informational, used in logs
#   TARGET_PORT        (default: 9000)         — HS forward target inside this container
#   HS_SECRET_KEY_B64  (optional)              — base64-encoded contents of
#                                                hs_ed25519_secret_key. When
#                                                set, seeded into the HS dir
#                                                so anon reuses the keypair
#                                                (deterministic .anyone address).
set -eu

NICKNAME=${NICKNAME:-probe}
TARGET_PORT=${TARGET_PORT:-9000}

mkdir -p /var/lib/anon/hs
chmod 0700 /var/lib/anon/hs

# Seed the v3 hidden-service keypair if provided. anon detects existing files
# under HiddenServiceDir and reuses them — no regeneration. The secret key MUST
# be mode 0600 or anon refuses to load it.
if [ -n "${HS_SECRET_KEY_B64:-}" ]; then
  echo "[probe ${NICKNAME}] seeding hs_ed25519_secret_key from HS_SECRET_KEY_B64"
  printf '%s' "${HS_SECRET_KEY_B64}" | base64 -d > /var/lib/anon/hs/hs_ed25519_secret_key
  chmod 0600 /var/lib/anon/hs/hs_ed25519_secret_key
  # anon regenerates the public key + hostname from the secret on first boot
  # if they're absent, so we don't need to seed those.
else
  echo "[probe ${NICKNAME}] HS_SECRET_KEY_B64 unset — anon will generate fresh keys (hostname will be unknown without lease shell)"
fi

# Generate torrc — public Anyone network, single hidden service.
RC=/etc/anon/torrc
cat > "$RC" <<EOF
AgreeToTerms 1
DataDirectory /var/lib/anon
SOCKSPort 0.0.0.0:9050
SOCKSPolicy accept *
HiddenServiceDir /var/lib/anon/hs
HiddenServicePort ${TARGET_PORT} 127.0.0.1:${TARGET_PORT}
Log notice stdout
RunAsDaemon 0
EOF

echo "[probe ${NICKNAME}] generated torrc:"
echo "============================================================"
cat "$RC"
echo "============================================================"

# In-container HS target. Any incoming TCP connection on 127.0.0.1:TARGET_PORT
# gets "PROBE-OK\n" and the connection closes. socat's `fork` lets it accept
# repeated connections. `bind=127.0.0.1` keeps it strictly intra-container —
# nothing reaches this port except via the hidden service forward.
(
  while true; do
    socat -T 5 \
      "TCP-LISTEN:${TARGET_PORT},bind=127.0.0.1,reuseaddr,fork" \
      'SYSTEM:printf "PROBE-OK\n"' \
      || true
    sleep 1
  done
) &

# Akash readiness responder. The Console API rejects manifests with "zero
# global services" — every deployment must expose AT LEAST ONE port to
# `to: global: true`. We expose port 8080 with a minimal HTTP responder
# (200 OK, no payload) purely to satisfy that validator AND give the
# kubelet readiness probe a quick green response. The .anyone hidden
# service remains the only operational access path; this port is a
# scaffolding-only beacon.
HEALTH_PORT=${HEALTH_PORT:-8080}
# Pre-build the HTTP response as a static file with REAL CRLFs, then have
# socat cat it on each connection. Avoids the shell-escape minefield where
# `\r\n` inside socat's SYSTEM: arg gets stripped/literalized depending on
# how dash and posh handle nested quoting.
HEALTH_FILE=/tmp/health-response
{
  printf 'HTTP/1.1 200 OK\r\n'
  printf 'Content-Length: 3\r\n'
  printf 'Content-Type: text/plain\r\n'
  printf 'Connection: close\r\n'
  printf '\r\n'
  printf 'OK\n'
} > "$HEALTH_FILE"
(
  while true; do
    socat -T 5 \
      "TCP-LISTEN:${HEALTH_PORT},reuseaddr,fork" \
      "SYSTEM:cat $HEALTH_FILE" \
      || true
    sleep 1
  done
) &

# Background watcher: log the published hostname once it appears. Kept for
# diagnostics on logs-readable deploys (lease-shell, local docker run); on
# Akash Console deploys we won't see this output, but it doesn't hurt.
(
  HOSTFILE=/var/lib/anon/hs/hostname
  while [ ! -s "$HOSTFILE" ]; do
    sleep 2
  done
  echo "[probe ${NICKNAME}] HS hostname: $(cat "$HOSTFILE" | tr -d '\n')"
) &

# Run anon in foreground. Container exit follows anon exit.
exec anon -f "$RC"
