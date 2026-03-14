/**
 * Attestation Server Placeholder (Story 4.1)
 *
 * Minimal HTTP server that serves the TEE attestation endpoint structure
 * expected by the Marlin Oyster CVM verification tooling. In production,
 * the real attestation document is provided by the Nitro hypervisor and
 * this placeholder is replaced with actual attestation document generation
 * (Story 4.2: kind:10033 event builder).
 *
 * Endpoints:
 *   GET /attestation/raw -- Returns placeholder attestation document
 *   GET /health          -- Returns health status with TEE detection
 *
 * Environment variables:
 *   ATTESTATION_PORT            -- HTTP port (default: 1300)
 *   ATTESTATION_REFRESH_INTERVAL -- Seconds between refreshes (default: 300)
 *   TEE_ENABLED                 -- Set by Oyster CVM runtime when in enclave
 *
 * This server runs as a separate supervisord-managed process (priority=20),
 * starting after the Crosstown node process (priority=10) to ensure the
 * relay is accepting connections before attestation is published.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

// TEE detection via environment variable (set by Oyster CVM runtime).
// Evaluated once at startup -- env var changes after process start are not reflected.
const teeEnabled = process.env['TEE_ENABLED'] === 'true';
const attestationPort = parseInt(
  process.env['ATTESTATION_PORT'] || '1300',
  10
);
if (isNaN(attestationPort) || attestationPort < 1 || attestationPort > 65535) {
  throw new Error(
    `ATTESTATION_PORT must be a valid port number (1-65535): ${process.env['ATTESTATION_PORT']}`
  );
}

// ATTESTATION_REFRESH_INTERVAL is accepted via env var (default: 300 seconds)
// but not used in this placeholder. Story 4.2 will implement periodic refresh.

/**
 * GET /attestation/raw
 *
 * Returns a placeholder attestation document. In a real Oyster CVM
 * deployment, this endpoint returns the Nitro attestation document
 * (CBOR-encoded COSE structure with PCR measurements). The placeholder
 * returns a JSON stub indicating the TEE state.
 *
 * Story 4.2 will implement real attestation document generation here.
 */
app.get('/attestation/raw', (c) => {
  if (teeEnabled) {
    // In TEE mode, return a placeholder attestation document structure.
    // Real implementation (Story 4.2) will return CBOR-encoded Nitro
    // attestation with PCR0/PCR1/PCR2 measurements.
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

// Start the HTTP server
if (process.env['VITEST'] === undefined) {
  serve({
    fetch: app.fetch,
    port: attestationPort,
  });
  console.log(
    `[Attestation] Server listening on http://0.0.0.0:${attestationPort}`
  );
  console.log(`[Attestation] TEE mode: ${teeEnabled ? 'enabled' : 'disabled'}`);
}

export { app };
