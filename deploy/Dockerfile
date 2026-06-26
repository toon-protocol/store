# =============================================================================
# store-connector — the published TOON connector with THIS repo's connector.yaml
# baked in. It is the payment proxy ("nginx for payments") that runs in front of
# the store (Arweave blob storage) backend. The store app image is built/published
# separately (Dockerfile.store → ghcr.io/toon-protocol/store); this image is
# ONLY the connector + the store route config.
#
# Config is BAKED (COPYed), not bind-mounted, so the published image is a
# self-contained, pinned deployable. TLS is terminated by the deployment
# environment (no Caddy here).
#
# The connector tag is pinned (NOT `latest`) so the config schema and the
# HTTP-envelope contract are frozen against a known connector. Bump CONNECTOR_TAG
# deliberately when adopting a newer connector.
# =============================================================================
ARG CONNECTOR_TAG=3.28.0
FROM ghcr.io/toon-protocol/connector:${CONNECTOR_TAG}

# Bake the store route config to the connector's default CONFIG_FILE location.
COPY connector.yaml /app/config/connector.yaml

# Entrypoint is inherited from the connector image (node packages/connector/dist/main.js).
# It reads CONFIG_FILE (default /app/config/connector.yaml). Edge :3000, health :8080.
