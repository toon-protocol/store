# syntax=docker/dockerfile:1.7
# Townhouse ATOR sidecar — runs `anon` directly (NOT via @anyone-protocol/anyone-client SDK)
# alongside the apex connector. Publishes a v3 hidden service that forwards
# inbound traffic to a sibling container's BTP server.
#
# Why this image exists separately from the connector image:
#   The @anyone-protocol/anyone-client SDK at v1.1.3 (which the published
#   connector image 3.3.3 bundles) does NOT support hidden-service publication.
#   The connector's source has the wiring (`ManagedAnonClient`, the
#   `externalUrl: 'auto'` resolver) but the SDK ignores HS opts and spawns
#   anon with /tmp/anonrc-{timestamp} containing only SOCKSPort. The connector
#   then waits 120s for /var/lib/anon/hs/hostname which the SDK never writes,
#   and bails with ENOENT.
#
#   This sidecar bypasses the SDK entirely. It runs the upstream-pinned
#   `anon` binary (v0.4.10.0-beta) with a hand-written torrc that includes
#   `HiddenServiceDir` + `HiddenServicePort` directives — the same approach
#   that worked end-to-end on Akash in Phase 1 (see deploy/akash/ator-probe.sdl.yaml).
#   Mirrors the connector team's own integration-test pattern at
#   connector/docker/ator-public-sidecar/.
#
# Architecture in compose / SDL:
#
#     external peer
#       │ wss://<addr>.anyone/btp
#       ▼
#     [Anyone HSDirs] -- HS descriptor --> ator-sidecar (:HS port)
#                                              │
#                                              │ HiddenServicePort 3000
#                                              │   connector:3000
#                                              ▼
#                                          connector (apex)
#                                              │ btp+ws://town:3000
#                                              │ btp+ws://mill:3000
#                                              ▼
#                                       child nodes (Docker DNS)
#
# The connector's transport is configured with managed=false, so the connector
# does NOT spawn its own anon. It treats this sidecar as an external SOCKS5
# proxy (for outbound BTP) and uses an explicit externalUrl set by the
# operator's `scripts/townhouse-hs-init.sh` (which knows the .anyone address
# because it pre-generated the keypair).
#
# Environment:
#   HS_SECRET_KEY_B64   (required) - base64-encoded hs_ed25519_secret_key. The
#                                    operator pre-generates the keypair locally
#                                    via scripts/townhouse-hs-init.sh and
#                                    injects the secret here. Without this, the
#                                    sidecar generates a fresh keypair and the
#                                    operator's pre-known .anyone address won't
#                                    match what gets published.
#   HS_PORT             (default 3000) - HS port advertised on the .anyone
#                                    address (peers dial <addr>.anyone:<HS_PORT>).
#   HS_TARGET_HOST      (default connector) - Docker DNS name of the BTP target.
#                                    The HiddenServicePort directive forwards
#                                    inbound HS traffic to <HS_TARGET_HOST>:<HS_PORT>.
#   HS_TARGET_PORT      (default 3000) - port on HS_TARGET_HOST. Usually same
#                                    as HS_PORT (peers reach the connector's
#                                    BTP server on the same logical port).
#   NICKNAME            (default townhouse-hs) - informational, used in logs.
#
# Build:
#   docker build -f docker/townhouse-ator-sidecar/Dockerfile -t toon:townhouse-ator-sidecar docker/townhouse-ator-sidecar
#
# Build context is THIS directory — no workspace dependencies.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG ANON_VERSION=0.4.10.0-beta
ARG DEB_REVISION=1.d12.bookworm+1
ARG ANON_RELEASE_BASE=https://github.com/anyone-protocol/ator-protocol/releases/download/v${ANON_VERSION}

# Runtime deps only. curl is purged after .deb install.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        netcat-openbsd \
    ; \
    rm -rf /var/lib/apt/lists/*

COPY checksums.txt /tmp/checksums.txt

RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) DEB_FILE="anon_${ANON_VERSION}-${DEB_REVISION}_amd64.deb" ;; \
        arm64) DEB_FILE="anon_${ANON_VERSION}-${DEB_REVISION}_arm64.deb" ;; \
        *)     echo "ERROR: unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    URL_FILE="$(echo "${DEB_FILE}" | sed 's/+/%2B/g')"; \
    curl -fsSL -o "/tmp/${DEB_FILE}" "${ANON_RELEASE_BASE}/${URL_FILE}"; \
    cd /tmp; \
    grep "  ${DEB_FILE}\$" /tmp/checksums.txt > /tmp/checksum.active; \
    sha256sum -c /tmp/checksum.active; \
    apt-get update; \
    echo 'anon anon/terms boolean true' | debconf-set-selections; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "/tmp/${DEB_FILE}"; \
    rm -f "/tmp/${DEB_FILE}" /tmp/checksums.txt /tmp/checksum.active; \
    apt-get purge -y --auto-remove curl; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    anon --version | grep -q "${ANON_VERSION}"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# State directories. We run as root (matches Phase 1 probe — Akash provider
# Pod Security Policies sometimes reject non-root images, see
# docker/Dockerfile.akash-anvil:18). anon's strict ownership check on
# /var/lib/anon then matches the running user.
RUN mkdir -p /var/lib/anon /etc/anon && \
    chown -R root:root /var/lib/anon /etc/anon

# Persistent volume — the .anyone keypair lives here. Mount this from a
# named docker volume in compose (or persistent storage on Akash) to keep
# the address stable across redeploys, OR inject the secret via
# HS_SECRET_KEY_B64 env (the entrypoint seeds it on every start).
VOLUME ["/var/lib/anon"]

# Expose 9050 only to the docker-internal network. The sidecar is NOT a
# public service — peers reach it via the .anyone HS, and the connector
# reaches the SOCKS port via Docker DNS (ator-sidecar:9050). Akash SDL
# does not declare any global expose for this service.
EXPOSE 9050

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
