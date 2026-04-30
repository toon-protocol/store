/**
 * Town Node Entrypoint Adapter (Story 21.5)
 *
 * Maps Townhouse orchestrator environment variables to Town CLI env vars,
 * then dynamically imports the Town CLI main function. This is compiled via
 * esbuild into a single ESM bundle for the Docker runtime stage.
 *
 * Environment variable mapping:
 *   CONNECTOR_URL        -> TOON_CONNECTOR_URL
 *   NODE_NOSTR_SECRET_KEY -> TOON_SECRET_KEY
 *   FEE_PER_EVENT        -> TOON_FEE_PER_EVENT
 *   BLS_PORT             -> TOON_BLS_PORT (default: 3100)
 *   WS_PORT              -> TOON_RELAY_PORT (default: 7100)
 *   DEV_MODE             -> TOON_DEV_MODE
 *   (data dir)           -> TOON_DATA_DIR = /data
 */

// --- Env var mapping (Townhouse -> Town CLI) ---

if (process.env['CONNECTOR_URL']) {
  process.env['TOON_CONNECTOR_URL'] = process.env['CONNECTOR_URL'];
}

if (process.env['CONNECTOR_ADMIN_URL']) {
  process.env['TOON_CONNECTOR_ADMIN_URL'] = process.env['CONNECTOR_ADMIN_URL'];
}

if (process.env['NODE_NOSTR_SECRET_KEY']) {
  process.env['TOON_SECRET_KEY'] = process.env['NODE_NOSTR_SECRET_KEY'];
}

if (process.env['FEE_PER_EVENT']) {
  process.env['TOON_FEE_PER_EVENT'] = process.env['FEE_PER_EVENT'];
}

process.env['TOON_BLS_PORT'] = process.env['BLS_PORT'] ?? '3100';
process.env['TOON_RELAY_PORT'] = process.env['WS_PORT'] ?? '7100';
process.env['TOON_DATA_DIR'] = '/data';

if (process.env['DEV_MODE'] === 'true') {
  process.env['TOON_DEV_MODE'] = 'true';
}

// --- Graceful shutdown ---
// The Town CLI registers its own SIGTERM/SIGINT handlers in main() that
// call instance.stop() for graceful shutdown. We do NOT register a handler
// here because Node.js fires handlers in registration order — an early
// process.exit(0) would preempt the CLI's graceful teardown of open
// connections and database writes.

// --- Import and run Town CLI ---
// esbuild resolves this from the workspace during the Docker build stage.
// The Town CLI's main() function auto-invokes on import (calls main() at module level).

await import('@toon-protocol/town/cli');
