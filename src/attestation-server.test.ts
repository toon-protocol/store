/**
 * HTTP-level tests for the attestation server (Story 4.1 Test Expansion)
 *
 * These tests exercise the Hono app's HTTP endpoints directly using
 * the app.request() test utility, covering the runtime behavior that
 * the static analysis tests in oyster-config.test.ts cannot reach.
 *
 * Coverage:
 *   - T-4.1-08: GET /attestation/raw returns 503 when not in TEE (AC #3)
 *   - T-4.1-09: GET /health returns {status: 'ok', tee: false} (AC #3)
 *   - T-4.1-10: GET /attestation/raw response structure (AC #3)
 *   - T-4.1-11: GET /health response structure (AC #3)
 *   - T-4.1-12: Unknown routes return 404 (negative path)
 */

import { describe, it, expect } from 'vitest';
import { app } from './attestation-server.js';

// ---------------------------------------------------------------------------
// T-4.1-08 [P1]: GET /attestation/raw when TEE_ENABLED is not set
// (AC #3 -- attestation server answers HTTP on port 1300)
// ---------------------------------------------------------------------------

describe('T-4.1-08: GET /attestation/raw (non-TEE mode)', () => {
  it('T-4.1-08a: returns 503 status when not in TEE', async () => {
    // Arrange & Act
    const res = await app.request('/attestation/raw');

    // Assert -- outside TEE, attestation is unavailable
    expect(res.status).toBe(503);
  });

  it('T-4.1-08b: response body indicates tee=false', async () => {
    // Arrange & Act
    const res = await app.request('/attestation/raw');
    const body = await res.json();

    // Assert -- tee field is false when not in enclave
    expect(body.tee).toBe(false);
  });

  it('T-4.1-08c: response body has status=unavailable', async () => {
    // Arrange & Act
    const res = await app.request('/attestation/raw');
    const body = await res.json();

    // Assert
    expect(body.status).toBe('unavailable');
  });

  it('T-4.1-08d: response body contains a message string', async () => {
    // Arrange & Act
    const res = await app.request('/attestation/raw');
    const body = await res.json();

    // Assert
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('T-4.1-08e: response body does NOT contain a timestamp (CWE-208 timing side-channel)', async () => {
    // Arrange & Act
    const res = await app.request('/attestation/raw');
    const body = await res.json();

    // Assert -- no timestamp field (removed to prevent timing information leakage)
    expect(body.timestamp).toBeUndefined();
  });

  it('T-4.1-08f: response content-type is application/json', async () => {
    // Arrange & Act
    const res = await app.request('/attestation/raw');

    // Assert
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});

// ---------------------------------------------------------------------------
// T-4.1-09 [P1]: GET /health endpoint behavior
// (AC #3 -- attestation server health check)
// ---------------------------------------------------------------------------

describe('T-4.1-09: GET /health', () => {
  it('T-4.1-09a: returns 200 status', async () => {
    // Arrange & Act
    const res = await app.request('/health');

    // Assert
    expect(res.status).toBe(200);
  });

  it('T-4.1-09b: returns status=ok', async () => {
    // Arrange & Act
    const res = await app.request('/health');
    const body = await res.json();

    // Assert
    expect(body.status).toBe('ok');
  });

  it('T-4.1-09c: returns tee=false when TEE_ENABLED is not set', async () => {
    // Arrange & Act
    const res = await app.request('/health');
    const body = await res.json();

    // Assert -- default (no TEE_ENABLED env var) is false
    expect(body.tee).toBe(false);
  });

  it('T-4.1-09d: response content-type is application/json', async () => {
    // Arrange & Act
    const res = await app.request('/health');

    // Assert
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});

// ---------------------------------------------------------------------------
// T-4.1-10 [P2]: Negative path -- unknown routes
// ---------------------------------------------------------------------------

describe('T-4.1-10: unknown routes', () => {
  it('T-4.1-10a: GET /nonexistent returns 404', async () => {
    // Arrange & Act
    const res = await app.request('/nonexistent');

    // Assert
    expect(res.status).toBe(404);
  });

  it('T-4.1-10b: POST /attestation/raw returns 404 (only GET is defined)', async () => {
    // Arrange & Act
    const res = await app.request('/attestation/raw', { method: 'POST' });

    // Assert -- POST is not registered, should get 404
    expect(res.status).toBe(404);
  });

  it('T-4.1-10c: POST /health returns 404 (only GET is defined)', async () => {
    // Arrange & Act
    const res = await app.request('/health', { method: 'POST' });

    // Assert
    expect(res.status).toBe(404);
  });
});
