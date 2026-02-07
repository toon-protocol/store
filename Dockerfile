# Agent Society Container
# Runs BLS (Business Logic Server) + Nostr Relay + Bootstrap Service
#
# Build from repo root:
#   docker build -f docker/Dockerfile -t agent-society .

FROM node:20-slim AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files for dependency installation
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/relay/package.json ./packages/relay/
COPY docker/package.json ./docker/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY packages/core/ ./packages/core/
COPY packages/relay/ ./packages/relay/
COPY docker/ ./docker/

# Build all packages
RUN pnpm -r build

# Production stage
FROM node:20-slim AS production

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy built packages
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/core/dist ./packages/core/dist
COPY --from=base /app/packages/core/package.json ./packages/core/
COPY --from=base /app/packages/relay/dist ./packages/relay/dist
COPY --from=base /app/packages/relay/package.json ./packages/relay/
COPY --from=base /app/docker/dist ./docker/dist
COPY --from=base /app/docker/package.json ./docker/
COPY --from=base /app/package.json ./

# Install production dependencies only
COPY --from=base /app/pnpm-lock.yaml ./
COPY --from=base /app/pnpm-workspace.yaml ./

# Expose ports
# BLS_PORT: Business Logic Server HTTP port
# WS_PORT: Nostr Relay WebSocket port
EXPOSE 3100 7100

# Environment variables (with defaults)
ENV NODE_ENV=production
ENV BLS_PORT=3100
ENV WS_PORT=7100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + process.env.BLS_PORT + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the entrypoint
CMD ["node", "docker/dist/entrypoint.js"]
