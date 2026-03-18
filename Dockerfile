# TOON Container (esbuild-bundled Multi-Stage Build)
# Runs BLS (Business Logic Server) + Nostr Relay + Bootstrap Service
#
# Build from repo root:
#   docker build -f docker/Dockerfile -t toon .
#
# esbuild bundles all JS into a self-contained file. Only the native module
# better-sqlite3 (used by SqliteEventStore) is copied separately.
# entrypoint-town.ts talks to an external connector via HTTP, so ethers/express
# are NOT needed (those are only required by the embedded ConnectorNode in
# Dockerfile.oyster). Target image: ~70MB (down from ~450MB).

# -- Stage 1: Builder --------------------------------------------------------
FROM node:20-alpine AS builder

# Install build dependencies for native modules
RUN apk add --no-cache python3 py3-setuptools make g++

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy dependency manifests for installation
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/bls/package.json ./packages/bls/
COPY packages/client/package.json ./packages/client/
COPY packages/core/package.json ./packages/core/
COPY packages/relay/package.json ./packages/relay/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/town/package.json ./packages/town/
COPY docker/package.json ./docker/

# Install all dependencies (including devDependencies needed for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY packages/bls/ ./packages/bls/
COPY packages/client/ ./packages/client/
COPY packages/core/ ./packages/core/
COPY packages/relay/ ./packages/relay/
COPY packages/sdk/ ./packages/sdk/
COPY packages/town/ ./packages/town/
COPY docker/ ./docker/

# Build all workspace packages (esbuild needs their dist/ exports)
# Then run esbuild to produce self-contained bundles
RUN pnpm -r build && cd docker && pnpm run build

# -- Assemble minimal runtime directory --------------------------------------
RUN mkdir -p /runtime/node_modules

# Copy esbuild bundle (town entrypoint for standard Docker)
RUN cp docker/dist/entrypoint-town.js /runtime/

# ESM package.json (bundles use import.meta.url via banner)
RUN echo '{"type":"module"}' > /runtime/package.json

# Cherry-pick better-sqlite3 (native module) + its runtime deps (bindings, file-uri-to-path)
# Each package resolved from pnpm store individually (version-agnostic globs)
RUN SQLITE_DIR=$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3) && \
    BINDINGS_DIR=$(ls -d node_modules/.pnpm/bindings@*/node_modules/bindings) && \
    FUTP_DIR=$(ls -d node_modules/.pnpm/file-uri-to-path@*/node_modules/file-uri-to-path) && \
    mkdir -p /runtime/node_modules/better-sqlite3/build/Release && \
    cp -r "$SQLITE_DIR/lib" /runtime/node_modules/better-sqlite3/ && \
    cp "$SQLITE_DIR/build/Release/better_sqlite3.node" \
       /runtime/node_modules/better-sqlite3/build/Release/ && \
    cp "$SQLITE_DIR/package.json" /runtime/node_modules/better-sqlite3/ && \
    cp -r "$BINDINGS_DIR" /runtime/node_modules/ && \
    cp -r "$FUTP_DIR" /runtime/node_modules/


# -- Stage 2: Runtime --------------------------------------------------------
FROM node:20-alpine

# Install runtime dependencies for native modules
RUN apk add --no-cache libstdc++

WORKDIR /app

# Copy minimal runtime from builder stage
COPY --from=builder /runtime ./

# Environment variables (with defaults)
ENV NODE_ENV=production
ENV BLS_PORT=3100
ENV WS_PORT=7100

# Expose ports
# BLS_PORT: Business Logic Server HTTP port
# WS_PORT: Nostr Relay WebSocket port
EXPOSE 3100 7100

# Create non-root user for security
RUN addgroup -g 1001 toon && \
    adduser -D -u 1001 -G toon toon && \
    mkdir -p /data && \
    chown -R toon:toon /app /data

# Volume for persistent data
VOLUME /data

# Switch to non-root user
USER toon

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:${BLS_PORT}/health || exit 1

# Run the SDK-based docker entrypoint (Town)
CMD ["node", "/app/entrypoint-town.js"]
