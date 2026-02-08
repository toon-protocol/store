# Agent Society Container
# Runs BLS (Business Logic Server) + Nostr Relay + Bootstrap Service
#
# Build from repo root:
#   docker build -f docker/Dockerfile -t agent-society .

FROM node:20-slim

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files for dependency installation
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/bls/package.json ./packages/bls/
COPY packages/core/package.json ./packages/core/
COPY packages/relay/package.json ./packages/relay/
COPY docker/package.json ./docker/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY packages/bls/ ./packages/bls/
COPY packages/core/ ./packages/core/
COPY packages/relay/ ./packages/relay/
COPY docker/ ./docker/

# Build all packages (including docker package)
RUN pnpm -r build && cd docker && pnpm run build

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
