/**
 * Unit tests for the x402 pay-per-upload Arweave adapter.
 *
 * HARD SAFETY RULE: every test drives injected stub deps. No test ever reaches
 * AR.IO's bundler, signs with a real key, or moves real (or testnet) USDC. The
 * fake private key below is a throwaway constant, never funded.
 *
 * Covers:
 *   - resolveX402Env: OFF by default (the inertness guarantee), file vs inline
 *     key, validation, and that a bad key is never echoed
 *   - X402UploadAdapter.upload: item signed before id is read, raw POST to the
 *     configured endpoint, receipt id preferred over local id, error surfacing
 *   - the payment ceiling is actually handed to wrapFetchWithPayment
 *   - init happens once across uploads, and a failed init does not poison the
 *     adapter
 */

import { describe, it, expect, vi } from 'vitest';
import {
  X402UploadAdapter,
  resolveX402Env,
  DEFAULT_X402_UPLOAD_URL,
  DEFAULT_X402_NETWORK,
  DEFAULT_X402_MAX_PAYMENT,
  type X402UploadDeps,
} from './x402-upload-adapter.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Throwaway, never funded, never used against a live chain. */
const FAKE_KEY = `0x${'a'.repeat(64)}`;
const ITEM_ID = 'LOCALLYCOMPUTEDITEMID_0000000000000000000000';
const RECEIPT_ID = 'RECEIPTIDFROMTHEBUNDLER_000000000000000000';

interface StubOptions {
  /** Response the payment-wrapped fetch returns. */
  response?: Response;
  /** Collects what the adapter did, for assertions. */
  calls?: {
    signed: number;
    fetches: { url: string; init?: RequestInit }[];
    maxValues: (bigint | undefined)[];
    signerArgs: { network: string; key: string }[];
    tags: { name: string; value: string }[][];
  };
  /** Make the lazy dep load fail (simulates a missing optional dependency). */
  failLoad?: boolean;
}

function makeDeps(opts: StubOptions = {}): {
  load: () => Promise<X402UploadDeps>;
  calls: NonNullable<StubOptions['calls']>;
} {
  const calls = opts.calls ?? {
    signed: 0,
    fetches: [],
    maxValues: [],
    signerArgs: [],
    tags: [],
  };

  const deps: X402UploadDeps = {
    createData: (data, _signer, o) => {
      calls.tags.push(o?.tags ?? []);
      let signed = false;
      return {
        // Mirrors arbundles: the id is only meaningful after sign().
        get id() {
          if (!signed) throw new Error('read id before sign()');
          return ITEM_ID;
        },
        sign: async () => {
          signed = true;
          calls.signed++;
        },
        getRaw: () => Buffer.concat([Buffer.from('RAW:'), data]),
      };
    },
    ArweaveSigner: class {
      constructor(public jwk: unknown) {}
    },
    createSigner: async (network, key) => {
      calls.signerArgs.push({ network, key });
      return { network };
    },
    wrapFetchWithPayment: (_f, _signer, maxValue) => {
      calls.maxValues.push(maxValue);
      return async (url, init) => {
        calls.fetches.push({ url, init });
        return (
          opts.response ??
          new Response(JSON.stringify({ id: RECEIPT_ID, winc: '0' }), { status: 200 })
        );
      };
    },
    decodeXPaymentResponse: (h) => ({ decoded: h }),
  };

  const load = async () => {
    if (opts.failLoad) throw new Error('optional dep missing');
    return deps;
  };
  return { load, calls };
}

function adapterWith(opts: StubOptions = {}, overrides: Record<string, unknown> = {}) {
  const { load, calls } = makeDeps(opts);
  const adapter = new X402UploadAdapter({
    arweaveJwk: { kty: 'RSA', n: 'n', d: 'd' },
    evmPrivateKey: FAKE_KEY,
    loadDeps: load,
    ...overrides,
  });
  return { adapter, calls };
}

// ── resolveX402Env ──────────────────────────────────────────────────────────

describe('resolveX402Env', () => {
  const noRead = () => {
    throw new Error('should not read a file');
  };

  it('is OFF when neither key var is set, so existing deployments are untouched', () => {
    expect(resolveX402Env({}, noRead)).toBeUndefined();
  });

  it('treats whitespace-only values as absent, not as a malformed key', () => {
    expect(
      resolveX402Env({ STORE_X402_EVM_KEY: '   ', STORE_X402_EVM_KEY_FILE: '  ' }, noRead)
    ).toBeUndefined();
  });

  it('reads the key from a file and reports the file as the source', () => {
    const res = resolveX402Env({ STORE_X402_EVM_KEY_FILE: '/keys/x402.key' }, (p) => {
      expect(p).toBe('/keys/x402.key');
      return `${FAKE_KEY}\n`; // trailing newline is the common case
    });
    expect(res?.evmPrivateKey).toBe(FAKE_KEY);
    expect(res?.keySource).toBe('STORE_X402_EVM_KEY_FILE');
  });

  it('applies documented defaults', () => {
    const res = resolveX402Env({ STORE_X402_EVM_KEY: FAKE_KEY }, noRead);
    expect(res?.uploadUrl).toBe(DEFAULT_X402_UPLOAD_URL);
    expect(res?.network).toBe(DEFAULT_X402_NETWORK);
    expect(res?.maxPaymentBaseUnits).toBe(DEFAULT_X402_MAX_PAYMENT);
    expect(res?.keySource).toBe('STORE_X402_EVM_KEY');
  });

  it('honours explicit overrides', () => {
    const res = resolveX402Env(
      {
        STORE_X402_EVM_KEY: FAKE_KEY,
        STORE_X402_UPLOAD_URL: 'https://upload.ardrive.io/v1/tx',
        STORE_X402_NETWORK: 'base-sepolia',
        STORE_X402_MAX_PAYMENT: '250000',
      },
      noRead
    );
    expect(res?.uploadUrl).toBe('https://upload.ardrive.io/v1/tx');
    expect(res?.network).toBe('base-sepolia');
    expect(res?.maxPaymentBaseUnits).toBe(250_000n);
  });

  it('rejects a malformed key WITHOUT echoing it', () => {
    const secret = 'not-a-key-but-still-secret';
    expect(() => resolveX402Env({ STORE_X402_EVM_KEY: secret }, noRead)).toThrow(
      /0x-prefixed 32-byte hex/
    );
    try {
      resolveX402Env({ STORE_X402_EVM_KEY: secret }, noRead);
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('rejects a key of the wrong length', () => {
    expect(() => resolveX402Env({ STORE_X402_EVM_KEY: `0x${'a'.repeat(63)}` }, noRead)).toThrow(
      /0x-prefixed 32-byte hex/
    );
  });

  it('surfaces an unreadable key file as a clear error', () => {
    expect(() =>
      resolveX402Env({ STORE_X402_EVM_KEY_FILE: '/nope' }, () => {
        throw new Error('ENOENT');
      })
    ).toThrow(/could not be read/);
  });

  it('rejects a non-numeric or non-positive payment ceiling', () => {
    expect(() =>
      resolveX402Env({ STORE_X402_EVM_KEY: FAKE_KEY, STORE_X402_MAX_PAYMENT: 'abc' }, noRead)
    ).toThrow(/USDC base units/);
    expect(() =>
      resolveX402Env({ STORE_X402_EVM_KEY: FAKE_KEY, STORE_X402_MAX_PAYMENT: '0' }, noRead)
    ).toThrow(/greater than zero/);
  });
});

// ── X402UploadAdapter ───────────────────────────────────────────────────────

describe('X402UploadAdapter.upload', () => {
  it('signs the item and POSTs the raw bytes to the configured endpoint', async () => {
    const { adapter, calls } = adapterWith({}, { uploadUrl: 'https://example.test/v1/tx' });
    const res = await adapter.upload(Buffer.from('hello'), { 'Content-Type': 'text/plain' });

    expect(calls.signed).toBe(1);
    expect(calls.fetches).toHaveLength(1);
    expect(calls.fetches[0]!.url).toBe('https://example.test/v1/tx');
    expect(calls.fetches[0]!.init?.method).toBe('POST');
    expect(
      (calls.fetches[0]!.init?.headers as Record<string, string>)['content-type']
    ).toBe('application/octet-stream');
    // The raw ANS-104 item goes on the wire, not the caller's plain bytes.
    expect(Buffer.from(calls.fetches[0]!.init?.body as Uint8Array).toString()).toBe('RAW:hello');
    expect(res.txId).toBe(RECEIPT_ID);
  });

  it('maps the tag record into arbundles name/value pairs', async () => {
    const { adapter, calls } = adapterWith();
    await adapter.upload(Buffer.from('x'), { 'App-Name': 'toon', 'Content-Type': 'text/plain' });
    expect(calls.tags[0]).toEqual([
      { name: 'App-Name', value: 'toon' },
      { name: 'Content-Type', value: 'text/plain' },
    ]);
  });

  it('tolerates absent tags', async () => {
    const { adapter, calls } = adapterWith();
    await adapter.upload(Buffer.from('x'));
    expect(calls.tags[0]).toEqual([]);
  });

  it('falls back to the locally computed item id when the receipt carries none', async () => {
    const { adapter } = adapterWith({
      response: new Response(JSON.stringify({ winc: '0' }), { status: 200 }),
    });
    expect((await adapter.upload(Buffer.from('x'))).txId).toBe(ITEM_ID);
  });

  it('falls back to the local item id when the 2xx body is not JSON', async () => {
    const { adapter } = adapterWith({ response: new Response('OK', { status: 200 }) });
    expect((await adapter.upload(Buffer.from('x'))).txId).toBe(ITEM_ID);
  });

  it('throws with status and body when the bundler refuses', async () => {
    const { adapter } = adapterWith({
      response: new Response('insufficient funds', { status: 402 }),
    });
    await expect(adapter.upload(Buffer.from('x'))).rejects.toThrow(
      /HTTP 402.*insufficient funds/s
    );
  });

  it('passes the payment ceiling through to wrapFetchWithPayment', async () => {
    const { adapter, calls } = adapterWith({}, { maxPaymentBaseUnits: 12_345n });
    await adapter.upload(Buffer.from('x'));
    expect(calls.maxValues[0]).toBe(12_345n);
  });

  it('defaults the ceiling and the network when unspecified', async () => {
    const { adapter, calls } = adapterWith();
    await adapter.upload(Buffer.from('x'));
    expect(calls.maxValues[0]).toBe(DEFAULT_X402_MAX_PAYMENT);
    expect(calls.signerArgs[0]).toEqual({ network: DEFAULT_X402_NETWORK, key: FAKE_KEY });
  });

  it('initialises the signer once across multiple uploads', async () => {
    const { adapter, calls } = adapterWith();
    await adapter.upload(Buffer.from('a'));
    await adapter.upload(Buffer.from('b'));
    expect(calls.signerArgs).toHaveLength(1);
    expect(calls.fetches).toHaveLength(2);
  });

  it('surfaces a missing optional dependency as a clear error', async () => {
    const { adapter } = adapterWith({ failLoad: true });
    await expect(adapter.upload(Buffer.from('x'))).rejects.toThrow(/optional dep missing/);
  });

  it('does not cache a failed init, so a later upload retries', async () => {
    let attempt = 0;
    const { load } = makeDeps();
    const adapter = new X402UploadAdapter({
      arweaveJwk: {},
      evmPrivateKey: FAKE_KEY,
      loadDeps: async () => {
        attempt++;
        if (attempt === 1) throw new Error('transient DNS');
        return load();
      },
    });
    await expect(adapter.upload(Buffer.from('x'))).rejects.toThrow(/transient DNS/);
    // Without dropping the cached promise this would reject forever.
    expect((await adapter.upload(Buffer.from('x'))).txId).toBe(RECEIPT_ID);
    expect(attempt).toBe(2);
  });

  it('logs the winc so a credits-vs-x402 mixup is visible in the boot log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { adapter } = adapterWith();
      await adapter.upload(Buffer.from('x'));
      // winc "0" is the proof nothing was drawn from prepaid Turbo credits.
      expect(spy.mock.calls.flat().join(' ')).toMatch(/winc=0/);
    } finally {
      spy.mockRestore();
    }
  });
});
