/**
 * Town Node Entrypoint Adapter (Story 21.5)
 *
 * Maps Townhouse orchestrator environment variables to Town CLI env vars,
 * then dynamically imports the Town CLI main function. This is compiled via
 * esbuild into a single ESM bundle for the Docker runtime stage.
 *
 * Environment variable mapping:
 *   CONNECTOR_URL        -> TOON_CONNECTOR_URL  (parent-connector BTP URL)
 *   NODE_NOSTR_SECRET_KEY -> TOON_SECRET_KEY
 *   FEE_PER_EVENT        -> TOON_FEE_PER_EVENT
 *   NODE_ID              -> TOON_NODE_ID         (peer id used in routes)
 *   ILP_ADDRESS          -> TOON_ILP_ADDRESS     (e.g. g.townhouse.town)
 *   PARENT_PEER_ID       -> TOON_PARENT_PEER_ID  (default: apex)
 *   PARENT_AUTH_TOKEN    -> TOON_PARENT_AUTH_TOKEN (default: empty/no-auth)
 *   BLS_PORT             -> TOON_BLS_PORT (default: 3100)
 *   WS_PORT              -> TOON_RELAY_PORT (default: 7100)
 *   DEV_MODE             -> TOON_DEV_MODE
 *   (data dir)           -> TOON_DATA_DIR = /data
 */

// --- Env var mapping (Townhouse -> Town CLI) ---

if (process.env['CONNECTOR_URL']) {
  process.env['TOON_CONNECTOR_URL'] = process.env['CONNECTOR_URL'];
}

if (process.env['NODE_NOSTR_SECRET_KEY']) {
  process.env['TOON_SECRET_KEY'] = process.env['NODE_NOSTR_SECRET_KEY'];
}

if (process.env['FEE_PER_EVENT']) {
  process.env['TOON_FEE_PER_EVENT'] = process.env['FEE_PER_EVENT'];
}

if (process.env['NODE_ID']) {
  process.env['TOON_NODE_ID'] = process.env['NODE_ID'];
}

if (process.env['ILP_ADDRESS']) {
  process.env['TOON_ILP_ADDRESS'] = process.env['ILP_ADDRESS'];
}

if (process.env['PARENT_PEER_ID']) {
  process.env['TOON_PARENT_PEER_ID'] = process.env['PARENT_PEER_ID'];
}

if (process.env['PARENT_AUTH_TOKEN'] !== undefined) {
  process.env['TOON_PARENT_AUTH_TOKEN'] = process.env['PARENT_AUTH_TOKEN'];
}

// Embedded-connector ClaimReceiver / chainProviders signer. When set, the
// child's embedded ConnectorNode signs claims with this key instead of the
// identity-derived secp256k1 hex. Lets operators wire a funded EVM account
// (e.g. Anvil deterministic privkey) without polluting Nostr identity.
if (process.env['SETTLEMENT_PRIVATE_KEY']) {
  process.env['TOON_SETTLEMENT_PRIVATE_KEY'] =
    process.env['SETTLEMENT_PRIVATE_KEY'];
}

// EVM treasury address advertised to the parent connector for the
// embedded-with-parent peer entry. The apex's PerPacketClaimService uses
// this as `peerAddress` when it opens a settlement channel toward this
// child.
if (process.env['PARENT_EVM_ADDRESS']) {
  process.env['TOON_PARENT_EVM_ADDRESS'] = process.env['PARENT_EVM_ADDRESS'];
}

// Public BTP endpoint the apex exposes to external clients (HS .anyone URL or
// direct ws://host:3000/btp). Advertised in this town's kind:10032 so clients
// learn where to route packets destined for g.townhouse.town. Without it the
// town would fall back to the internal `ws://localhost:3000` default, which is
// unreachable from outside the Docker network.
if (process.env['PUBLIC_BTP_URL']) {
  process.env['TOON_BTP_ENDPOINT'] = process.env['PUBLIC_BTP_URL'];
}

// Public Nostr relay READ URL advertised in this town's kind:10032 (`relayUrl`)
// and kind:10166 seed entry, so clients discover where to subscribe for free
// reads. Set by the orchestrator (HS .anyone relay URL or direct public URL).
if (process.env['PUBLIC_RELAY_URL']) {
  process.env['TOON_EXTERNAL_RELAY_URL'] = process.env['PUBLIC_RELAY_URL'];
}

// Settlement asset advertised in kind:10032 (operator-configurable token). When
// unset the town defaults to USD/scale-6.
if (process.env['ASSET_CODE']) {
  process.env['TOON_ASSET_CODE'] = process.env['ASSET_CODE'];
}
if (process.env['ASSET_SCALE']) {
  process.env['TOON_ASSET_SCALE'] = process.env['ASSET_SCALE'];
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
