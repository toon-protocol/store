# Crosstown Container (Optimized Multi-Stage Build)
# Runs BLS (Business Logic Server) + Nostr Relay + Bootstrap Service
#
# Build from repo root:
#   docker build -f docker/Dockerfile -t crosstown .
#
# Optimizations:
#   - Alpine base (vs Debian Slim) = ~400 MB savings
#   - Multi-stage build = ~600 MB savings (excludes devDeps)
#   - Native module cleanup = ~50 MB savings
#   - Expected total: ~450 MB (vs 1.53 GB)

# ── Stage 1: Builder ─────────────────────────────────────────
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
COPY docker/package.json ./docker/

# Install all dependencies (including devDependencies needed for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY packages/bls/ ./packages/bls/
COPY packages/client/ ./packages/client/
COPY packages/core/ ./packages/core/
COPY packages/relay/ ./packages/relay/
COPY docker/ ./docker/

# Build all packages
RUN pnpm -r build && cd docker && pnpm run build

# Deploy production dependencies only (no devDeps, no symlinks)
# This creates a clean production deployment at /prod
RUN pnpm --filter @crosstown/docker deploy --prod /prod

# Copy package.json files and built artifacts to production deployment
RUN mkdir -p /prod/packages/bls /prod/packages/client /prod/packages/core /prod/packages/relay && \
    cp packages/bls/package.json /prod/packages/bls/ && \
    cp packages/client/package.json /prod/packages/client/ && \
    cp packages/core/package.json /prod/packages/core/ && \
    cp packages/relay/package.json /prod/packages/relay/ && \
    cp -r packages/bls/dist /prod/packages/bls/ && \
    cp -r packages/client/dist /prod/packages/client/ && \
    cp -r packages/core/dist /prod/packages/core/ && \
    cp -r packages/relay/dist /prod/packages/relay/ && \
    cp -r docker/dist /prod/docker/ && \
    cp tsconfig.json /prod/

# Clean up native module build artifacts to save space
# Note: Keep build/ directories as they contain compiled .node files needed at runtime
# Note: Keep simple-git dependencies intact (it uses src/ directories)
RUN find /prod/node_modules -type d -name 'deps' -prune -exec rm -rf {} + && \
    find /prod/node_modules -type d -name 'src' -prune ! -path '*/simple-git/*' ! -path '*/debug/*' -exec rm -rf {} + && \
    find /prod/node_modules -type f -name 'binding.gyp' -delete

# ── Stage 2: Runtime ─────────────────────────────────────────
FROM node:20-alpine

# Install runtime dependencies for native modules
RUN apk add --no-cache libstdc++

WORKDIR /app

# Copy production build from builder stage
COPY --from=builder /prod ./

# Environment variables (with defaults)
ENV NODE_ENV=production
ENV BLS_PORT=3100
ENV WS_PORT=7100

# Expose ports
# BLS_PORT: Business Logic Server HTTP port
# WS_PORT: Nostr Relay WebSocket port
EXPOSE 3100 7100

# Create non-root user for security
RUN addgroup -g 1001 crosstown && \
    adduser -D -u 1001 -G crosstown crosstown && \
    mkdir -p /data && \
    chown -R crosstown:crosstown /app /data

# Volume for persistent data
VOLUME /data

# Switch to non-root user
USER crosstown

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:${BLS_PORT}/health || exit 1

# Run the docker entrypoint
CMD ["node", "/app/dist/entrypoint.js"]
