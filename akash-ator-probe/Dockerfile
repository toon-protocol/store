# syntax=docker/dockerfile:1.7
# ATOR-on-Akash probe image — pinned anon v0.4.10.0-beta, no-ingress design.
#
# Mission: validate that the @anyone-protocol `anon` binary boots, joins the
# public Anyone network, and publishes a hidden service descriptor when run
# inside an Akash provider's container runtime. Nothing in this container is
# externally reachable — the .anyone address (pre-generated locally and seeded
# via HS_SECRET_KEY_B64) IS the access mechanism. The round-trip test dials
# that address through a local anon SOCKS5 proxy, confirms PROBE-OK response.
#
# Build (amd64):  docker build --platform linux/amd64 -t ator-probe:v0.4.10.0-beta -f docker/akash-ator-probe/Dockerfile docker/akash-ator-probe/
# Build (arm64):  docker build --platform linux/arm64 -t ator-probe:v0.4.10.0-beta -f docker/akash-ator-probe/Dockerfile docker/akash-ator-probe/
#
# Build context is THIS directory (not repo root) — checksums.txt + entrypoint.sh
# are the only inputs; nothing from the workspace is copied in.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG ANON_VERSION=0.4.10.0-beta
ARG DEB_REVISION=1.d12.bookworm+1
ARG ANON_RELEASE_BASE=https://github.com/anyone-protocol/ator-protocol/releases/download/v${ANON_VERSION}

# Runtime deps. curl is purged after .deb install. socat is the in-container
# HS target (tiny TCP listener responding "PROBE-OK\n" so the round-trip test
# can verify the .anyone → hidden-service-port → 127.0.0.1:TARGET_PORT path is
# alive). No HTTP server — this container has no public ingress.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        netcat-openbsd \
        socat \
    ; \
    rm -rf /var/lib/apt/lists/*

COPY checksums.txt /tmp/checksums.txt

# Download + verify the .deb for TARGETARCH. Both amd64 and arm64 are pinned in
# checksums.txt; sha256sum -c fails the build on mismatch (no silent pass).
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) DEB_FILE="anon_${ANON_VERSION}-${DEB_REVISION}_amd64.deb" ;; \
        arm64) DEB_FILE="anon_${ANON_VERSION}-${DEB_REVISION}_arm64.deb" ;; \
        *)     echo "ERROR: unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    URL_FILE="$(echo "${DEB_FILE}" | sed 's/+/%2B/g')"; \
    echo "Fetching ${ANON_RELEASE_BASE}/${URL_FILE}"; \
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

# State directories used by the entrypoint. We run as root because some Akash
# providers' Kubernetes Pod Security Policies reject non-root images outright
# (matches the pattern in docker/Dockerfile.akash-anvil:18). For a derisking
# probe this is acceptable; the production townhouse SDL will reintroduce a
# non-root user once we identify which providers tolerate it.
#
# Anon's .deb postinst creates a `debian-anon` user (uid 100) and chowns
# /var/lib/anon to that user. When we seed an existing hs_ed25519_secret_key
# and run anon as root, anon sees the directory owner-mismatch, closes its
# Socks listener mid-init, and segfaults with "free(): invalid size". chown
# everything to root NOW so root-running anon is happy with the layout.
RUN mkdir -p /var/lib/anon /etc/anon && \
    chown -R root:root /var/lib/anon /etc/anon

# Persistent volume — when this is mounted as Akash persistent storage the
# .anyone address survives redeploys (hs_ed25519_secret_key lives under
# /var/lib/anon/hs/). For the probe we use HS_SECRET_KEY_B64 env injection
# instead, which works without persistent storage.
VOLUME ["/var/lib/anon"]

# Port 8080 is a minimal "I'm alive" HTTP responder (socat-backed in the
# entrypoint). It exists ONLY to satisfy Akash Console API's "at least one
# global service" manifest validator and the kubelet readiness probe — the
# operational access path is exclusively the .anyone hidden service.
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
