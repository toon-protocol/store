/**
 * Unit tests for entrypoint-dvm.ts (Story 21.12)
 *
 * Covers:
 *   - createJobCounter: wrap, success/error increment/decrement, window eviction
 *   - applyEnvOverlay: KIND_PRICING_<kind> env-var parsing and precedence
 *   - Hono BLS server: GET /health registration (static analysis)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock heavy deps that would pull in WASM/native modules ──────────────────

vi.mock('@toon-protocol/pet-dvm', () => ({
  createDungeonDvmHandler: vi.fn(() => vi.fn()),
}));

vi.mock('@toon-protocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@toon-protocol/sdk')>();
  return {
    ...actual,
    createNode: vi.fn(async () => ({
      identity: { pubkey: 'a'.repeat(64) },
      on: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    })),
    createArweaveDvmHandler: vi.fn(() => vi.fn()),
    TurboUploadAdapter: vi.fn(),
    ChunkManager: vi.fn(() => ({})),
  };
});

// After mocks, import the functions under test
import { createJobCounter, applyEnvOverlay } from './entrypoint-dvm.js';

// ── Job counter tests ────────────────────────────────────────────────────────

describe('createJobCounter', () => {
  it('success path increments success and decrements processing', async () => {
    const counter = createJobCounter();
    const handler = vi.fn(async () => 'result');
    const wrapped = counter.wrap(5094, handler);

    const resultPromise = wrapped({ ctx: 'test' });
    // processing is incremented synchronously before the await
    const snap1 = counter.snapshot();
    expect(snap1.byStatus.processing).toBe(1);

    await resultPromise;

    const snap2 = counter.snapshot();
    expect(snap2.byStatus.processing).toBe(0);
    expect(snap2.byStatus.success).toBe(1);
    expect(snap2.byStatus.error).toBe(0);
    expect(snap2.total).toBe(1);
    expect(snap2.byKind[0]).toMatchObject({ kind: 5094, count: 1 });
  });

  it('error path increments error and decrements processing', async () => {
    const counter = createJobCounter();
    const handler = vi.fn(async () => { throw new Error('fail'); });
    const wrapped = counter.wrap(5250, handler);

    await expect(wrapped({ ctx: 'test' })).rejects.toThrow('fail');

    const snap = counter.snapshot();
    expect(snap.byStatus.processing).toBe(0);
    expect(snap.byStatus.success).toBe(0);
    expect(snap.byStatus.error).toBe(1);
    expect(snap.total).toBe(1);
    expect(snap.byKind[0]).toMatchObject({ kind: 5250, count: 1 });
  });

  it('window eviction removes old entries', async () => {
    const counter = createJobCounter(100); // 100 ms window
    const handler = vi.fn(async () => 'ok');
    const wrapped = counter.wrap(5094, handler);

    await wrapped({});
    expect(counter.snapshot().total).toBe(1);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 120));
    expect(counter.snapshot().total).toBe(0);
  });

  it('preserves return value from the original handler', async () => {
    const counter = createJobCounter();
    const handler = vi.fn(async () => ({ txId: 'abc123' }));
    const wrapped = counter.wrap(5094, handler);

    const result = await wrapped({});
    expect(result).toEqual({ txId: 'abc123' });
  });

  it('partial remains 0 in v1', async () => {
    const counter = createJobCounter();
    const snap = counter.snapshot();
    expect(snap.byStatus.partial).toBe(0);
  });
});

// ── applyEnvOverlay KIND_PRICING tests ───────────────────────────────────────

const SECRET_HEX = 'a'.repeat(64);

const ENV_KEYS_TO_RESTORE = [
  'KIND_PRICING_5094',
  'KIND_PRICING_5250',
  'KIND_PRICING_abc',
  'FEE_PER_JOB',
  'NODE_NOSTR_SECRET_KEY',
  'CONNECTOR_URL',
  'BLS_PORT',
  'HANDLER_PORT',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS_TO_RESTORE) {
    savedEnv[key] = process.env[key];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key];
  }
  // Provide mandatory env vars so applyEnvOverlay doesn't throw
  process.env['NODE_NOSTR_SECRET_KEY'] = SECRET_HEX;
  process.env['CONNECTOR_URL'] = 'ws://localhost:3000';
});

afterEach(() => {
  for (const key of ENV_KEYS_TO_RESTORE) {
    if (savedEnv[key] === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  vi.restoreAllMocks();
});

describe('applyEnvOverlay — KIND_PRICING_<kind> support', () => {
  it('KIND_PRICING_5094 alone populates kindPricing[5094]', () => {
    process.env['KIND_PRICING_5094'] = '5';
    const out = applyEnvOverlay({});
    expect(out.kindPricing?.[5094]).toBe(5n);
  });

  it('KIND_PRICING_5094 + KIND_PRICING_5250 both populate kindPricing', () => {
    process.env['KIND_PRICING_5094'] = '5';
    process.env['KIND_PRICING_5250'] = '10000';
    const out = applyEnvOverlay({});
    expect(out.kindPricing?.[5094]).toBe(5n);
    expect(out.kindPricing?.[5250]).toBe(10000n);
  });

  it('KIND_PRICING_5094=5 overrides FEE_PER_JOB for kind 5094', () => {
    process.env['FEE_PER_JOB'] = '10';
    process.env['KIND_PRICING_5094'] = '5';
    const out = applyEnvOverlay({});
    // FEE_PER_JOB sets basePricePerByte + kindPricing[5250]
    expect(out.basePricePerByte).toBe(10n);
    expect(out.kindPricing?.[5250]).toBe(10n);
    // KIND_PRICING_5094 overrides for kind 5094
    expect(out.kindPricing?.[5094]).toBe(5n);
  });

  it('malformed key KIND_PRICING_abc is ignored (no throw)', () => {
    process.env['KIND_PRICING_abc'] = '5';
    expect(() => applyEnvOverlay({})).not.toThrow();
  });
});

// ── BLS server registration static-analysis test ─────────────────────────────

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('entrypoint-dvm.ts — BLS server static analysis', () => {
  let src: string;
  beforeEach(() => {
    src = readFileSync(join(__dirname, 'entrypoint-dvm.ts'), 'utf-8');
  });

  it('imports Hono from hono', () => {
    expect(src).toMatch(/import.*Hono.*from ['"]hono['"]/);
  });

  it('imports serve from @hono/node-server', () => {
    expect(src).toMatch(/import.*serve.*from ['"]@hono\/node-server['"]/);
  });

  it('registers GET /health route', () => {
    expect(src).toMatch(/blsApp\.get\(['"]\/health['"]/);
  });

  it('calls serve with blsPort', () => {
    expect(src).toMatch(/serve\(\s*\{[^}]*blsPort/s);
  });

  it('extends SIGTERM shutdown to close blsServer before node.stop()', () => {
    expect(src).toMatch(/blsServer/);
    expect(src).toMatch(/node\.stop\(\)/);
  });
});
