/**
 * Attestation Server (Stories 4.1 + 4.2)
 *
 * HTTP server that serves TEE attestation endpoints for Marlin Oyster CVM
 * verification tooling AND publishes kind:10033 TEE Attestation events to
 * the local Nostr relay for peer/client verification.
 *
 * Dual-channel attestation exposure (Decision 12):
 * - HTTP-native: /attestation/raw endpoint for Marlin CVM verification tooling
 * - Nostr-native: kind:10033 events on the relay network for peer discovery
 *
 * Endpoints:
 *   GET /attestation/raw -- Returns placeholder attestation document (Story 4.1)
 *   GET /health          -- Returns health status with TEE detection
 *
 * Environment variables:
 *   ATTESTATION_PORT             -- HTTP port (default: 1300)
 *   ATTESTATION_REFRESH_INTERVAL -- Seconds between refreshes (default: 300)
 *   TEE_ENABLED                  -- Set by Oyster CVM runtime when in enclave
 *   NOSTR_SECRET_KEY             -- 64-char hex secret key for event signing
 *   WS_PORT                      -- WebSocket relay port (default: 7100)
 *   TOON_CHAIN              -- Chain preset name (default: 'anvil')
 *   EXTERNAL_RELAY_URL           -- External relay URL for attestation tags
 *
 * This server runs as a separate supervisord-managed process (priority=20),
 * starting after the TOON node process (priority=10) to ensure the
 * relay is accepting connections before attestation is published.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import WebSocket from 'ws';
import { getPublicKey } from 'nostr-tools/pure';
import {
  buildAttestationEvent,
  deriveFromKmsSeed,
  type TeeAttestation,
} from '@toon-protocol/core';

const app = new Hono();

// TEE detection via environment variable (set by Oyster CVM runtime).
// Evaluated once at startup -- env var changes after process start are not reflected.
const teeEnabled = process.env['TEE_ENABLED'] === 'true';
const attestationPort = parseInt(process.env['ATTESTATION_PORT'] || '1300', 10);
if (isNaN(attestationPort) || attestationPort < 1 || attestationPort > 65535) {
  throw new Error(
    `ATTESTATION_PORT must be a valid port number (1-65535): ${process.env['ATTESTATION_PORT']}`
  );
}

// Attestation refresh interval in seconds (default: 300)
const refreshIntervalSeconds = parseInt(
  process.env['ATTESTATION_REFRESH_INTERVAL'] || '300',
  10
);
if (isNaN(refreshIntervalSeconds) || refreshIntervalSeconds < 1) {
  throw new Error(
    `ATTESTATION_REFRESH_INTERVAL must be a positive integer: ${process.env['ATTESTATION_REFRESH_INTERVAL']}`
  );
}

// WebSocket relay port for publishing kind:10033 events
const wsPort = parseInt(process.env['WS_PORT'] || '7100', 10);
if (isNaN(wsPort) || wsPort < 1 || wsPort > 65535) {
  throw new Error(
    `WS_PORT must be a valid port number (1-65535): ${process.env['WS_PORT']}`
  );
}

// Chain ID for attestation event tags
const chainId = process.env['TOON_CHAIN'] || '31337';

// External relay URL for attestation event tags
// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- default for internal Docker network
const externalRelayUrl =
  process.env['EXTERNAL_RELAY_URL'] || `ws://localhost:${wsPort}`;

// Interval handle for cleanup
let refreshInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Reads attestation data from the TEE environment.
 * In production Oyster CVM, this reads from the Nitro attestation endpoint.
 * For this story, returns placeholder attestation data when TEE_ENABLED=true.
 */
function readAttestationData(): TeeAttestation {
  // In a real deployment, this would query the Nitro hypervisor
  // /dev/nsm for the attestation document with PCR measurements.
  // For now, return placeholder data that matches the expected format.
  return {
    enclave: 'marlin-oyster',
    pcr0: '0'.repeat(96),
    pcr1: '0'.repeat(96),
    pcr2: '0'.repeat(96),
    attestationDoc: Buffer.from('placeholder-attestation-document').toString(
      'base64'
    ),
    version: '1.0.0',
  };
}

/**
 * Publishes a kind:10033 attestation event to the local relay via WebSocket.
 *
 * Uses the standard Nostr protocol: sends ["EVENT", signedEvent] and waits
 * for a response. The relay is already running at priority=10 before the
 * attestation server starts at priority=20.
 */
async function publishAttestationEvent(
  secretKey: Uint8Array,
  attestation: TeeAttestation
): Promise<void> {
  const expiry = Math.floor(Date.now() / 1000) + refreshIntervalSeconds * 2;

  const event = buildAttestationEvent(attestation, secretKey, {
    relay: externalRelayUrl,
    chain: chainId,
    expiry,
  });

  const pubkey = getPublicKey(secretKey);
  console.log(
    `[Attestation] Publishing kind:10033 event (pubkey: ${pubkey.slice(0, 16)}...)`
  );

  // Publish to local relay via WebSocket
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- internal Docker network, container-to-localhost
  const wsUrl = `ws://localhost:${wsPort}`;

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const timeout = setTimeout(() => {
      ws.close();
      if (!settled) {
        settled = true;
        reject(new Error('WebSocket publish timed out'));
      }
    }, 10000);

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as unknown[];
        // Nostr relay returns ["OK", eventId, success, message]
        if (Array.isArray(msg) && msg[0] === 'OK') {
          clearTimeout(timeout);
          if (msg[2]) {
            console.log(
              `[Attestation] Event published: ${event.id.slice(0, 16)}...`
            );
          } else {
            const reason =
              typeof msg[3] === 'string' ? msg[3].slice(0, 200) : 'unknown';
            console.warn(`[Attestation] Event rejected by relay: ${reason}`);
          }
          ws.close();
          if (!settled) {
            settled = true;
            resolve();
          }
        }
      } catch {
        // ignore parse errors from other messages
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      console.error(`[Attestation] WebSocket error: ${err.message}`);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      // Resolve if connection closed after sending but before OK response
      // (e.g., relay accepted silently or closed gracefully). This prevents
      // the promise from hanging indefinitely.
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}

/**
 * Starts the kind:10033 attestation publishing lifecycle.
 * Publishes an initial event and sets up periodic refresh.
 */
async function startAttestationLifecycle(secretKey: Uint8Array): Promise<void> {
  const attestation = readAttestationData();

  // Publish initial attestation event
  try {
    await publishAttestationEvent(secretKey, attestation);
    console.log('[Attestation] Initial attestation event published');
  } catch (err) {
    console.error(
      '[Attestation] Failed to publish initial event:',
      err instanceof Error ? err.message : err
    );
  }

  // Set up refresh interval
  refreshInterval = setInterval(async () => {
    try {
      const freshAttestation = readAttestationData();
      await publishAttestationEvent(secretKey, freshAttestation);
    } catch (err) {
      console.error(
        '[Attestation] Failed to refresh event:',
        err instanceof Error ? err.message : err
      );
    }
  }, refreshIntervalSeconds * 1000);
}

/**
 * Stops the attestation refresh interval.
 */
function stopRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = undefined;
  }
}

/**
 * GET /attestation/raw
 *
 * Returns a placeholder attestation document. In a real Oyster CVM
 * deployment, this endpoint returns the Nitro attestation document
 * (CBOR-encoded COSE structure with PCR measurements). The placeholder
 * returns a JSON stub indicating the TEE state.
 */
app.get('/attestation/raw', (c) => {
  if (teeEnabled) {
    // In TEE mode, return a placeholder attestation document structure.
    // NOTE: No server timestamp in response to avoid timing side-channel leakage (CWE-208).
    return c.json({
      status: 'placeholder',
      tee: true,
      message:
        'Attestation document generation not yet implemented (Story 4.2)',
    });
  }

  // Outside TEE, return a stub indicating no attestation is available.
  // NOTE: No server timestamp in response to avoid timing side-channel leakage (CWE-208).
  return c.json(
    {
      status: 'unavailable',
      tee: false,
      message: 'Not running inside TEE enclave',
    },
    503
  );
});

/**
 * GET /health
 *
 * Returns health status of the attestation server with TEE detection.
 * The `tee` field indicates whether the server is running inside a
 * TEE enclave (detected via TEE_ENABLED environment variable).
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    tee: teeEnabled,
  });
});

// Start the HTTP server and attestation lifecycle
if (process.env['VITEST'] === undefined) {
  serve({
    fetch: app.fetch,
    port: attestationPort,
  });
  console.log(
    `[Attestation] Server listening on http://0.0.0.0:${attestationPort}`
  );
  console.log(`[Attestation] TEE mode: ${teeEnabled ? 'enabled' : 'disabled'}`);

  // Start kind:10033 publishing lifecycle if TEE is enabled
  if (teeEnabled) {
    // Identity derivation: NOSTR_MNEMONIC (KMS pipeline) takes precedence over NOSTR_SECRET_KEY
    let secretKey: Uint8Array | undefined;
    const mnemonic = process.env['NOSTR_MNEMONIC'];
    if (mnemonic && mnemonic.trim().length > 0) {
      const keypair = deriveFromKmsSeed(new Uint8Array(32), {
        mnemonic: mnemonic.trim(),
      });
      secretKey = keypair.secretKey;
      console.log(
        `[Attestation] Identity derived from NOSTR_MNEMONIC via NIP-06 (pubkey: ${keypair.pubkey.slice(0, 16)}...)`
      );
    } else {
      const secretKeyHex = process.env['NOSTR_SECRET_KEY'];
      if (secretKeyHex && /^[0-9a-f]{64}$/.test(secretKeyHex)) {
        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- secret is read from env var, not hardcoded
        secretKey = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
      }
    }

    if (secretKey) {
      console.log(`[Attestation] Refresh interval: ${refreshIntervalSeconds}s`);
      startAttestationLifecycle(secretKey).catch((err) => {
        console.error('[Attestation] Lifecycle startup failed:', err);
      });
    } else {
      console.warn(
        '[Attestation] NOSTR_MNEMONIC and NOSTR_SECRET_KEY not set or invalid -- skipping kind:10033 publishing'
      );
    }
  }
}

export { app, stopRefresh, startAttestationLifecycle, publishAttestationEvent };
