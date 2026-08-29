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
  // Use a constructable class for TurboUploadAdapter so `new` works in tests.
  class TurboUploadAdapterStub {
    public client: unknown;
    constructor(client: unknown) {
      this.client = client;
    }
    async upload() {
      return { txId: 'stub-tx' };
    }
  }
  return {
    ...actual,
    createNode: vi.fn(async () => ({
      identity: { pubkey: 'a'.repeat(64) },
      on: vi.fn(),
      start: vi.fn((): Promise<void> => Promise.resolve()),
      stop: vi.fn((): Promise<void> => Promise.resolve()),
    })),
    createArweaveDvmHandler: vi.fn(() => vi.fn()),
    TurboUploadAdapter: TurboUploadAdapterStub,
    ChunkManager: vi.fn(() => ({})),
  };
});

// Mock @ardrive/turbo-sdk/node so we can introspect which path createTurboAdapter
// took without doing real network / signer work.
const ArweaveSignerCalls: { jwk: unknown }[] = [];
const TurboFactoryCalls: { args: unknown }[] = [];
const TurboFactoryUnauthCalls: { args: unknown }[] = [];
vi.mock('@ardrive/turbo-sdk/node', () => {
  class ArweaveSigner {
    public jwk: unknown;
    constructor(jwk: unknown) {
      this.jwk = jwk;
      ArweaveSignerCalls.push({ jwk });
    }
  }
  return {
    ArweaveSigner,
    TurboFactory: {
      authenticated: vi.fn((args: unknown) => {
        TurboFactoryCalls.push({ args });
        return {
          // Probe-friendly: tests can override per case via mockResolvedValueOnce.
          getBalance: vi.fn(async () => ({ winc: '0' })),
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
  resolveTurboCreditToken,
  DEFAULT_TURBO_CREDIT_TOKEN,
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

// ── createTurboAdapter — STORE_ARWEAVE_JWK_B64 + TURBO_TOKEN resolution (Phase 4) ──

describe('createTurboAdapter — STORE_ARWEAVE_JWK_B64 + TURBO_TOKEN resolution', () => {
  // A minimum-viable RSA JWK shape. We don't care about cryptographic validity
  // — the mocked ArweaveSigner just records what it received.
  const FAKE_JWK = {
    kty: 'RSA',
    n: Buffer.from('a'.repeat(64)).toString('base64url'),
    e: 'AQAB',
    d: 'd-value',
    p: 'p-value',
    q: 'q-value',
    dp: 'dp-value',
    dq: 'dq-value',
    qi: 'qi-value',
  };

  beforeEach(() => {
    ArweaveSignerCalls.length = 0;
    TurboFactoryCalls.length = 0;
    TurboFactoryUnauthCalls.length = 0;
  });

  it('STORE_ARWEAVE_JWK_B64 set + valid JWK → constructs ArweaveSigner-backed client', async () => {
    const b64 = Buffer.from(JSON.stringify(FAKE_JWK), 'utf-8').toString('base64');
    const result = await createTurboAdapter(b64, undefined);

    expect(result.source).toBe('arweave-jwk-b64');
    expect(result.adapter).toBeDefined();
    expect(result.client).toBeDefined();
    expect(ArweaveSignerCalls).toHaveLength(1);
    expect(ArweaveSignerCalls[0]?.jwk).toMatchObject({ kty: 'RSA' });
    expect(TurboFactoryCalls).toHaveLength(1);
    expect(TurboFactoryCalls[0]?.args).toMatchObject({ token: 'ario' });
    // Address must be derivable from the modulus n field.
    expect(result.arweaveAddress).toBeDefined();
    expect(typeof result.arweaveAddress).toBe('string');
  });

  it('STORE_ARWEAVE_JWK_B64 malformed base64 → clean error, no silent fallback', async () => {
    // Provide a TURBO_TOKEN to prove we do NOT fall back to it.
    const legacyToken = JSON.stringify(FAKE_JWK);
    // `Buffer.from(..., 'base64')` doesn't throw on most non-base64 strings —
    // it returns garbage bytes. So the malformed case is detected at the
    // JSON.parse step. Pass clearly-non-JSON bytes.
    const garbageB64 = Buffer.from('this is not json', 'utf-8').toString('base64');
    await expect(createTurboAdapter(garbageB64, legacyToken)).rejects.toThrow(
      /STORE_ARWEAVE_JWK_B64 does not decode to valid JSON/
    );
    // ArweaveSigner must NOT have been constructed (we bailed before).
    expect(ArweaveSignerCalls).toHaveLength(0);
  });

  it('STORE_ARWEAVE_JWK_B64 missing RSA fields → clean error, no silent fallback', async () => {
    const badJwk = { kty: 'EC', n: undefined };
    const b64 = Buffer.from(JSON.stringify(badJwk), 'utf-8').toString('base64');
    const legacyToken = JSON.stringify(FAKE_JWK);
    await expect(createTurboAdapter(b64, legacyToken)).rejects.toThrow(
      /missing required RSA JWK fields/
    );
    expect(ArweaveSignerCalls).toHaveLength(0);
  });

  it('STORE_ARWEAVE_JWK_B64 absent + TURBO_TOKEN set → legacy path used', async () => {
    const legacyToken = JSON.stringify(FAKE_JWK);
    const result = await createTurboAdapter(undefined, legacyToken);

    expect(result.source).toBe('turbo-token-legacy');
    expect(result.adapter).toBeDefined();
    expect(result.client).toBeDefined();
    // Legacy path uses `privateKey:` not the ArweaveSigner constructor.
    expect(ArweaveSignerCalls).toHaveLength(0);
    expect(TurboFactoryCalls).toHaveLength(1);
    expect(TurboFactoryCalls[0]?.args).toMatchObject({ privateKey: expect.any(Object) });
  });

  it('Both absent → ephemeral JWK free-tier adapter (≤100KB uploads via TurboFactory.authenticated)', async () => {
    const result = await createTurboAdapter(undefined, undefined);

    expect(result.source).toBe('unauthenticated-free-tier');
    expect(result.client).toBeDefined();
    expect(result.arweaveAddress).toBeUndefined();
    expect(ArweaveSignerCalls).toHaveLength(0);
    // Free-tier path uses an ephemeral JWK via TurboFactory.authenticated() so
    // Turbo accepts ≤100KB uploads without a funded wallet.
    expect(TurboFactoryCalls).toHaveLength(1);
    expect(TurboFactoryUnauthCalls).toHaveLength(0);
    // Adapter is functional — does not throw on upload.
    await expect(
      result.adapter.upload({} as Parameters<typeof result.adapter.upload>[0])
    ).resolves.toBeDefined();
  });

  it('Empty-string TURBO_TOKEN ("") → free tier, NOT a throwing/invalid-creds path (#146)', async () => {
    // The deployed dvm container sets TURBO_TOKEN="" (len 0). An empty string
    // must be treated as ABSENT and resolve to the free-tier uploader, never as
    // "present but invalid" (which would reject kind:5094 with T00).
    const result = await createTurboAdapter('', '');
    expect(result.source).toBe('unauthenticated-free-tier');
    expect(result.client).toBeDefined();
    expect(ArweaveSignerCalls).toHaveLength(0);
    expect(TurboFactoryCalls).toHaveLength(1);
    await expect(
      result.adapter.upload({} as Parameters<typeof result.adapter.upload>[0])
    ).resolves.toBeDefined();
  });

  it('Whitespace-only creds ("  ") → free tier (trimmed to absent, no JSON.parse throw) (#146)', async () => {
    const result = await createTurboAdapter('  ', '\n\t ');
    expect(result.source).toBe('unauthenticated-free-tier');
    expect(result.client).toBeDefined();
    expect(ArweaveSignerCalls).toHaveLength(0);
    expect(TurboFactoryCalls).toHaveLength(1);
  });

  // ── STORE_TURBO_SOLANA_KEY — paying for uploads in $ARIO ─────────────────
  //
  // The no-Arweave-wallet path. turbo-sdk maps `token: 'ario'` to a Solana
  // signer, so this key signs the data items and owns every upload made under
  // it. Format facts verified against turbo-sdk 1.42.0 while writing this:
  // despite the name, `HexSolanaSigner` wants BASE58 of the 64-byte secret
  // (87-88 chars), and the resulting account address is Arweave-shaped
  // base64url, NOT the Solana pubkey.

  // 88 base58 chars, no 0/O/I/l — a well-formed stand-in, never a real key.
  const FAKE_SOLANA_KEY_B58 =
    '4wBqpZM9xaSheZzJSMawUHDgZ7miWfSsxmfVF5jJpYPBCyxTb1GKQ7VJXjHUxUHK2Wd8vVJDPTFVjKjLYPqEtWfN';

  it('STORE_TURBO_SOLANA_KEY takes precedence and pays in $ARIO', async () => {
    const result = await createTurboAdapter(
      undefined,
      undefined,
      'ario',
      FAKE_SOLANA_KEY_B58
    );
    expect(result.source).toBe('ario-solana');
    expect(result.token).toBe('ario');
    // The key goes in as `privateKey`, not as an ArweaveSigner: turbo-sdk is
    // what turns it into a Solana signer, keyed off the token.
    expect(ArweaveSignerCalls).toHaveLength(0);
    expect(TurboFactoryCalls[0]?.args).toMatchObject({
      privateKey: FAKE_SOLANA_KEY_B58,
      token: 'ario',
    });
  });

  it('prefers the Solana key over a JWK, and says so', async () => {
    // Both set is a migration state, not a config error — but it silently
    // changes which wallet OWNS the uploads, so it must not pass quietly.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const b64 = Buffer.from(JSON.stringify(FAKE_JWK), 'utf-8').toString('base64');
    const result = await createTurboAdapter(b64, undefined, 'ario', FAKE_SOLANA_KEY_B58);
    expect(result.source).toBe('ario-solana');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('STORE_ARWEAVE_JWK_B64'));
    warn.mockRestore();
  });

  it('rejects a hex Solana key with a message that names the fix', async () => {
    // The live footgun: ARNS_DVM_SOLANA_SECRET_KEY is stored as hex in this
    // repo, so reaching for that value here is the obvious mistake. Without
    // this check it surfaces as "Non-base58 character" from inside turbo-sdk.
    const hex = 'a'.repeat(128);
    await expect(
      createTurboAdapter(undefined, undefined, 'ario', hex)
    ).rejects.toThrow(/base58/);
  });

  it('rejects a base58 key of the wrong length', async () => {
    await expect(
      createTurboAdapter(undefined, undefined, 'ario', 'abcdef')
    ).rejects.toThrow(/64-byte/);
  });

  it('refuses a Solana key paired with a non-ario token', async () => {
    // A Solana key is only a credential for the ario token; the pair is a
    // contradiction, and guessing which half the operator meant is worse than
    // refusing.
    await expect(
      createTurboAdapter(undefined, undefined, 'arweave', FAKE_SOLANA_KEY_B58)
    ).rejects.toThrow(/STORE_TURBO_SOLANA_KEY pays in \$ARIO/);
  });

  it('falls through to the JWK when no Solana key is set', async () => {
    const b64 = Buffer.from(JSON.stringify(FAKE_JWK), 'utf-8').toString('base64');
    const blank = await createTurboAdapter(b64, undefined, 'ario', '   ');
    expect(blank.source).toBe('arweave-jwk-b64');
  });

  // ── $ARIO credits (owner decision 2026-08-28) ────────────────────────────
  //
  // `token` picks the CURRENCY credits are quoted and bought in, not the
  // signer: every path below still signs with the Arweave JWK, so the address
  // that owns the data items and holds the balance does not move when this
  // flips. Verified against live Turbo while making the switch: 1 MiB costs
  // the same 11,600,114,792 winc under both tokens (0.0178 AR / 26.59 ARIO).

  it('defaults to $ARIO credits when STORE_TURBO_TOKEN is unset', () => {
    expect(DEFAULT_TURBO_CREDIT_TOKEN).toBe('ario');
    expect(resolveTurboCreditToken(undefined)).toBe('ario');
    // Empty and whitespace-only are ABSENT, not invalid — same rule the JWK
    // and TURBO_TOKEN vars follow (#146), because a here-doc env file can
    // leave a trailing newline behind.
    expect(resolveTurboCreditToken('')).toBe('ario');
    expect(resolveTurboCreditToken('   \n\t ')).toBe('ario');
  });

  it('honours an explicit STORE_TURBO_TOKEN, trimmed', () => {
    expect(resolveTurboCreditToken('arweave')).toBe('arweave');
    expect(resolveTurboCreditToken('  ario\n')).toBe('ario');
  });

  it('refuses an unrecognised STORE_TURBO_TOKEN instead of falling back', () => {
    // TurboFactory itself accepts the whole turbo-sdk union (solana, ethereum,
    // usdc, kyve, ...), so a wrong-but-plausible value would construct a client
    // denominated in a token nobody funded. That surfaces much later as
    // uploads failing for "no credits" against a balance that reads fine, so
    // it fails at boot by name instead.
    expect(() => resolveTurboCreditToken('solana')).toThrow(/STORE_TURBO_TOKEN/);
    expect(() => resolveTurboCreditToken('ARIO')).toThrow(/must be one of/);
  });

  it('passes the credit token to Turbo on every credential path', async () => {
    const b64 = Buffer.from(JSON.stringify(FAKE_JWK), 'utf-8').toString('base64');

    const jwkPath = await createTurboAdapter(b64, undefined, 'ario');
    expect(jwkPath.token).toBe('ario');
    expect(TurboFactoryCalls[0]?.args).toMatchObject({ token: 'ario' });

    TurboFactoryCalls.length = 0;
    const legacy = await createTurboAdapter(undefined, JSON.stringify(FAKE_JWK), 'ario');
    expect(legacy.token).toBe('ario');
    expect(TurboFactoryCalls[0]?.args).toMatchObject({ token: 'ario' });

    // The free tier is denominated too: its ephemeral wallet cannot be funded,
    // but the boot log must not claim a token the other paths would not use.
    TurboFactoryCalls.length = 0;
    const free = await createTurboAdapter(undefined, undefined, 'ario');
    expect(free.source).toBe('unauthenticated-free-tier');
    expect(free.token).toBe('ario');
    expect(TurboFactoryCalls[0]?.args).toMatchObject({ token: 'ario' });
  });

  it('still supports arweave-denominated credits for a box that has not migrated', async () => {
    const b64 = Buffer.from(JSON.stringify(FAKE_JWK), 'utf-8').toString('base64');
    const result = await createTurboAdapter(b64, undefined, 'arweave');
    expect(result.token).toBe('arweave');
    expect(TurboFactoryCalls[0]?.args).toMatchObject({ token: 'arweave' });
    // The signer is the JWK either way — switching currency must not move the
    // address that owns the uploads.
    expect(ArweaveSignerCalls).toHaveLength(1);
    expect(result.arweaveAddress).toBeDefined();
  });

  it('DVM AR address is non-empty when JWK source resolves (feed-through for boot-log)', async () => {
    const b64 = Buffer.from(JSON.stringify(FAKE_JWK), 'utf-8').toString('base64');
    const result = await createTurboAdapter(b64, undefined);
    expect(result.arweaveAddress).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.arweaveAddress?.length).toBeGreaterThan(10);
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
