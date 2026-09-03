/**
 * Unit tests for entrypoint-store.ts
 *
 * Covers:
 *   - createJobCounter: wrap, success/error increment/decrement, window eviction
 *   - applyEnvOverlay: KIND_PRICING_<kind> env-var parsing and precedence
 *   - Hono BLS server: GET /health registration (static analysis)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as SdkModule from '@toon-protocol/sdk';

// ── Mock heavy deps that would pull in WASM/native modules ──────────────────

vi.mock('@toon-protocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof SdkModule>();
  return {
    ...actual,
    createNode: vi.fn(async () => ({
      identity: { pubkey: 'a'.repeat(64) },
      on: vi.fn(),
      start: vi.fn((): Promise<void> => Promise.resolve()),
      stop: vi.fn((): Promise<void> => Promise.resolve()),
    })),
    createArweaveDvmHandler: vi.fn(() => vi.fn()),
    ChunkManager: vi.fn(() => ({})),
  };
});

// Mock @ardrive/turbo-sdk/node so we can introspect which path createTurboAdapter
// took without doing real network / signer work.
const TurboFactoryCalls: { args: unknown }[] = [];
const TurboFactoryUnauthCalls: { args: unknown }[] = [];
vi.mock('@ardrive/turbo-sdk/node', () => {
  return {
    TurboFactory: {
      authenticated: vi.fn((args: unknown) => {
        TurboFactoryCalls.push({ args });
        return {
          upload: vi.fn(async () => ({ id: 'fake-txid' })),
          // The sha256-shaped Turbo account address a token:'ario' client
          // reports for its signing key (NOT the Solana pubkey).
          signer: { getNativeAddress: vi.fn(async () => 'MNC4_fake_turbo_account') },
        };
      }),
      unauthenticated: vi.fn((args: unknown) => {
        TurboFactoryUnauthCalls.push({ args });
        return { upload: vi.fn(async () => ({ id: 'fake-txid' })) };
      }),
    },
  };
});

// After mocks, import the functions under test
import {
  createJobCounter,
  applyEnvOverlay,
  refuseRetiredTurboCredentials,
  createTurboAdapter,
} from './entrypoint-store.js';

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
  // The store identity key (applyEnvOverlay validates its hex format if present).
  process.env['NODE_NOSTR_SECRET_KEY'] = SECRET_HEX;
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

  it('KIND_PRICING_5094=5 coexists with FEE_PER_JOB basePricePerByte', () => {
    process.env['FEE_PER_JOB'] = '10';
    process.env['KIND_PRICING_5094'] = '5';
    const out = applyEnvOverlay({});
    // FEE_PER_JOB sets basePricePerByte. (kind:5250 was removed in commit
    // ca29625 — DVM is Arweave-only now, so FEE_PER_JOB no longer fans
    // out to a per-kind entry.)
    expect(out.basePricePerByte).toBe(10n);
    // KIND_PRICING_5094 sets kind 5094 pricing
    expect(out.kindPricing?.[5094]).toBe(5n);
  });

  it('malformed key KIND_PRICING_abc is ignored (no throw)', () => {
    process.env['KIND_PRICING_abc'] = '5';
    expect(() => applyEnvOverlay({})).not.toThrow();
  });
});

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── createTurboAdapter — ONE credential (store#128) ─────────────────────────
//
// The no-Arweave-wallet model. turbo-sdk maps `token: 'ario'` to a Solana
// signer, so the key signs the data items and owns every upload made under
// it. Format facts verified against turbo-sdk 1.42.0 while writing this:
// despite the name, `HexSolanaSigner` wants BASE58 of the 64-byte secret
// (87-88 chars), and the resulting account address is sha256-shaped
// base64url, NOT the Solana pubkey.

describe('createTurboAdapter — one Solana credential', () => {
  beforeEach(() => {
    TurboFactoryCalls.length = 0;
    TurboFactoryUnauthCalls.length = 0;
  });

  // 88 base58 chars, no 0/O/I/l — a well-formed stand-in, never a real key.
  const FAKE_SOLANA_KEY_B58 =
    '4wBqpZM9xaSheZzJSMawUHDgZ7miWfSsxmfVF5jJpYPBCyxTb1GKQ7VJXjHUxUHK2Wd8vVJDPTFVjKjLYPqEtWfN';

  it('STORE_TURBO_SOLANA_KEY → $ARIO client keyed by that key, with its Turbo account address', async () => {
    const result = await createTurboAdapter(FAKE_SOLANA_KEY_B58);
    expect(result.source).toBe('ario-solana');
    // The key goes in as `privateKey`: turbo-sdk is what turns it into a
    // Solana signer, keyed off the token.
    expect(TurboFactoryCalls).toHaveLength(1);
    expect(TurboFactoryCalls[0]?.args).toMatchObject({
      privateKey: FAKE_SOLANA_KEY_B58,
      token: 'ario',
    });
    expect(result.arweaveAddress).toBe('MNC4_fake_turbo_account');
  });

  it('hands the stated Solana gateway to turbo-sdk', async () => {
    // store#123: the gateway is where turbo-sdk picks its mint from, so the
    // validated URL must actually reach the constructed client -- a validation
    // that never flows into the construction protects nothing.
    const result = await createTurboAdapter(
      FAKE_SOLANA_KEY_B58,
      'https://solana-rpc.publicnode.com'
    );
    expect(result.source).toBe('ario-solana');
    expect(TurboFactoryCalls[0]?.args).toMatchObject({
      gatewayUrl: 'https://solana-rpc.publicnode.com',
    });
  });

  it('omits gatewayUrl when none is stated, keeping the SDK default', async () => {
    const result = await createTurboAdapter(FAKE_SOLANA_KEY_B58);
    expect(result.source).toBe('ario-solana');
    expect(
      Object.keys(TurboFactoryCalls[0]?.args as Record<string, unknown>)
    ).not.toContain('gatewayUrl');
  });

  it('no key → ephemeral Solana key, free tier only, still an authenticated $ARIO client', async () => {
    // Turbo grants free small-data-item uploads to any valid signer, so a
    // keyless box degrades to the free tier rather than dying (#146's spirit,
    // now on a Solana key: one signer kind everywhere).
    const result = await createTurboAdapter(undefined);
    expect(result.source).toBe('ephemeral-free-tier');
    expect(result.arweaveAddress).toBeUndefined();
    expect(TurboFactoryCalls).toHaveLength(1);
    expect(TurboFactoryUnauthCalls).toHaveLength(0);
    const args = TurboFactoryCalls[0]?.args as { privateKey?: string; token?: string };
    expect(args.token).toBe('ario');
    // A freshly generated 64-byte secret, base58: 87-88 chars, never the
    // configured-key path's undefined.
    expect(args.privateKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,89}$/);
  });

  it('an ephemeral key is generated fresh per call (it must not be fundable)', async () => {
    await createTurboAdapter(undefined);
    await createTurboAdapter('');
    const a = (TurboFactoryCalls[0]?.args as { privateKey?: string }).privateKey;
    const b = (TurboFactoryCalls[1]?.args as { privateKey?: string }).privateKey;
    expect(a).not.toBe(b);
  });

  it('empty and whitespace-only keys are ABSENT, not invalid (#146)', async () => {
    // A here-doc env file can leave a trailing newline behind; that must
    // resolve to the free tier, never to a base58 error.
    expect((await createTurboAdapter('')).source).toBe('ephemeral-free-tier');
    expect((await createTurboAdapter('  \n\t ')).source).toBe('ephemeral-free-tier');
  });

  it('rejects a hex Solana key with a message that names the fix', async () => {
    // The live footgun: ARNS_DVM_SOLANA_SECRET_KEY is stored as hex in this
    // repo, so reaching for that value here is the obvious mistake. Without
    // this check it surfaces as "Non-base58 character" from inside turbo-sdk.
    const hex = 'a'.repeat(128);
    await expect(createTurboAdapter(hex)).rejects.toThrow(/base58/);
  });

  it('rejects a base58 key of the wrong length', async () => {
    await expect(createTurboAdapter('abcdef')).rejects.toThrow(/64-byte/);
  });
});

// ── refuseRetiredTurboCredentials — the removed paths refuse, not degrade ───

describe('refuseRetiredTurboCredentials', () => {
  it('accepts a clean environment, and the vestigial STORE_TURBO_TOKEN=ario', () => {
    expect(() => refuseRetiredTurboCredentials({})).not.toThrow();
    expect(() =>
      refuseRetiredTurboCredentials({ STORE_TURBO_TOKEN: 'ario' })
    ).not.toThrow();
    // Empty strings are absent, the rule every credential var follows (#146).
    expect(() =>
      refuseRetiredTurboCredentials({
        STORE_ARWEAVE_JWK_B64: '',
        TURBO_TOKEN: '  ',
        STORE_TURBO_TOKEN: '',
      })
    ).not.toThrow();
  });

  it('refuses a configured JWK by name, with the migration path', () => {
    // Silently ignoring it would boot a node whose operator believes a
    // specific funded wallet signs its uploads.
    expect(() =>
      refuseRetiredTurboCredentials({ STORE_ARWEAVE_JWK_B64: 'eyJrdHkiOiJSU0EifQ==' })
    ).toThrow(/STORE_ARWEAVE_JWK_B64.*removed.*STORE_TURBO_SOLANA_KEY/s);
    expect(() =>
      refuseRetiredTurboCredentials({ TURBO_TOKEN: '{"kty":"RSA"}' })
    ).toThrow(/TURBO_TOKEN.*removed/s);
  });

  it('refuses a non-ario STORE_TURBO_TOKEN', () => {
    expect(() =>
      refuseRetiredTurboCredentials({ STORE_TURBO_TOKEN: 'arweave' })
    ).toThrow(/\$ARIO only/);
  });
});

describe('entrypoint-store.ts — BLS server static analysis', () => {
  let src: string;
  beforeEach(() => {
    src = readFileSync(join(__dirname, 'entrypoint-store.ts'), 'utf-8');
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

  it('extends SIGTERM shutdown to close blsServer and the store backend', () => {
    expect(src).toMatch(/blsServer/);
    expect(src).toMatch(/storeBackend\.close\(/);
  });
});
