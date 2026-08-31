/**
 * Unit tests for turbo-funding.ts (store#123, reworked in review on #128).
 *
 * Everything here drives the exported functions against stubs; no test ever
 * reaches a chain, a Turbo, or a clock it does not control. The seam under
 * test is the same one #122's suite established: what was constructed, what
 * was decided, and what was reported.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  ARIO_MINTS,
  TURBO_FREE_TIER_MAX_BYTES,
  createOnDemandUploadAdapter,
  estimateDataItemBytes,
  resolveTurboOnDemandEnv,
  resolveTurboSolanaNetwork,
  type TurboOnDemandClient,
} from './turbo-funding.js';

// ---------------------------------------------------------------------------
// resolveTurboSolanaNetwork — network and mint are decisions, not inferences
// ---------------------------------------------------------------------------

describe('resolveTurboSolanaNetwork', () => {
  it('defaults to mainnet with the mainnet mint', () => {
    const cfg = resolveTurboSolanaNetwork({});
    expect(cfg.network).toBe('mainnet');
    expect(cfg.mint).toBe(ARIO_MINTS.mainnet);
    expect(cfg.gatewayUrl).toBeUndefined();
  });

  it('accepts an explicit mainnet gateway', () => {
    const cfg = resolveTurboSolanaNetwork({
      STORE_TURBO_SOLANA_NETWORK: 'mainnet',
      STORE_TURBO_SOLANA_GATEWAY: 'https://solana-rpc.publicnode.com',
    });
    expect(cfg.gatewayUrl).toBe('https://solana-rpc.publicnode.com');
    expect(cfg.mint).toBe(ARIO_MINTS.mainnet);
  });

  it('refuses to start on mainnet with a devnet gateway', () => {
    // The mismatch that would otherwise fail silently in production: turbo-sdk
    // picks the mint by the "devnet" substring, so this combination spends a
    // token nobody funded.
    expect(() =>
      resolveTurboSolanaNetwork({
        STORE_TURBO_SOLANA_NETWORK: 'mainnet',
        STORE_TURBO_SOLANA_GATEWAY: 'https://api.devnet.solana.com',
      })
    ).toThrow(/devnet/);
  });

  it('refuses devnet without an explicit devnet gateway', () => {
    expect(() =>
      resolveTurboSolanaNetwork({ STORE_TURBO_SOLANA_NETWORK: 'devnet' })
    ).toThrow(/devnet/);
    expect(() =>
      resolveTurboSolanaNetwork({
        STORE_TURBO_SOLANA_NETWORK: 'devnet',
        STORE_TURBO_SOLANA_GATEWAY: 'https://api.mainnet-beta.solana.com',
      })
    ).toThrow(/devnet/);
  });

  it('selects the devnet mint when devnet is stated consistently', () => {
    const cfg = resolveTurboSolanaNetwork({
      STORE_TURBO_SOLANA_NETWORK: 'devnet',
      STORE_TURBO_SOLANA_GATEWAY: 'https://api.devnet.solana.com',
    });
    expect(cfg.network).toBe('devnet');
    expect(cfg.mint).toBe(ARIO_MINTS.devnet);
  });

  it('redacts the gateway URL to its origin in the mismatch refusal', () => {
    // Helius/QuickNode-style URLs carry the API key in the path or query, and
    // the boot refusal lands in the operator's log.
    try {
      resolveTurboSolanaNetwork({
        STORE_TURBO_SOLANA_NETWORK: 'mainnet',
        STORE_TURBO_SOLANA_GATEWAY: 'https://devnet.helius-rpc.com/?api-key=SECRET-API-KEY',
      });
      expect.unreachable('must throw on the mainnet/devnet mismatch');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('SECRET-API-KEY');
      expect(message).toContain('https://devnet.helius-rpc.com');
    }
  });

  it('rejects an unrecognised network by name', () => {
    expect(() =>
      resolveTurboSolanaNetwork({ STORE_TURBO_SOLANA_NETWORK: 'testnet' })
    ).toThrow(/STORE_TURBO_SOLANA_NETWORK/);
  });
});

// ---------------------------------------------------------------------------
// resolveTurboOnDemandEnv — the ceiling IS the spend authorization
// ---------------------------------------------------------------------------

describe('resolveTurboOnDemandEnv', () => {
  it('unset means the paid route is off', () => {
    expect(resolveTurboOnDemandEnv({})).toEqual({ paidUploadsEnabled: false });
    expect(resolveTurboOnDemandEnv({ STORE_TURBO_MAX_ARIO_PER_UPLOAD: '' })).toEqual({
      paidUploadsEnabled: false,
    });
    expect(resolveTurboOnDemandEnv({ STORE_TURBO_MAX_ARIO_PER_UPLOAD: '  ' })).toEqual({
      paidUploadsEnabled: false,
    });
  });

  it('a positive number turns the paid route on, bounded at that much', () => {
    expect(resolveTurboOnDemandEnv({ STORE_TURBO_MAX_ARIO_PER_UPLOAD: '5' })).toEqual({
      maxArioPerUpload: 5,
      paidUploadsEnabled: true,
    });
    expect(resolveTurboOnDemandEnv({ STORE_TURBO_MAX_ARIO_PER_UPLOAD: '0.5' })).toEqual({
      maxArioPerUpload: 0.5,
      paidUploadsEnabled: true,
    });
  });

  it('throws on a malformed value rather than degrading to the free tier', () => {
    // A box that asked for paid uploads and silently got the free tier would
    // refuse jobs it was configured to serve.
    for (const bad of ['0', '-1', 'five', 'NaN', 'Infinity']) {
      expect(() =>
        resolveTurboOnDemandEnv({ STORE_TURBO_MAX_ARIO_PER_UPLOAD: bad })
      ).toThrow(/STORE_TURBO_MAX_ARIO_PER_UPLOAD/);
    }
  });
});

// ---------------------------------------------------------------------------
// createOnDemandUploadAdapter — route by SIGNED size; pay per upload, bounded
// ---------------------------------------------------------------------------

const SMALL = Buffer.alloc(1024, 1);
const BIG = Buffer.alloc(TURBO_FREE_TIER_MAX_BYTES + 1, 1);

const silentLog = { info: vi.fn(), warn: vi.fn() };

function stubClient(): TurboOnDemandClient & { upload: ReturnType<typeof vi.fn> } {
  return {
    upload: vi.fn(async () => ({ id: 'stub-tx' })),
  };
}

describe('createOnDemandUploadAdapter', () => {
  it('submits a free-tier-sized upload with NO funding mode, tags mapped', async () => {
    const client = stubClient();
    const adapter = createOnDemandUploadAdapter({
      client,
      signerKind: 'solana-ed25519',
      maxArioPerUpload: 5,
      log: silentLog,
    });
    const result = await adapter.upload(SMALL, { a: 'b' });
    expect(result.txId).toBe('stub-tx');
    expect(client.upload).toHaveBeenCalledTimes(1);
    const params = client.upload.mock.calls[0]?.[0] as {
      data: Buffer;
      dataItemOpts?: unknown;
      fundingMode?: unknown;
    };
    expect(params.data).toBe(SMALL);
    expect(params.dataItemOpts).toEqual({ tags: [{ name: 'a', value: 'b' }] });
    expect(params.fundingMode).toBeUndefined();
  });

  it('submits an above-ceiling upload WITH OnDemandFunding carrying the ceiling', async () => {
    const client = stubClient();
    const fundingMode = { marker: 'on-demand' };
    const createFundingMode = vi.fn(async () => fundingMode);
    const adapter = createOnDemandUploadAdapter({
      client,
      signerKind: 'solana-ed25519',
      maxArioPerUpload: 5,
      log: silentLog,
      createFundingMode,
    });
    const result = await adapter.upload(BIG);
    expect(result.txId).toBe('stub-tx');
    expect(createFundingMode).toHaveBeenCalledWith(5);
    expect(client.upload.mock.calls[0]?.[0]?.fundingMode).toBe(fundingMode);
  });

  it('the default funding-mode factory builds a real OnDemandFunding with the ceiling', async () => {
    const client = stubClient();
    const adapter = createOnDemandUploadAdapter({
      client,
      signerKind: 'solana-ed25519',
      maxArioPerUpload: 3,
      log: silentLog,
    });
    await adapter.upload(BIG);
    const { OnDemandFunding } = await import('@ardrive/turbo-sdk/node');
    const mode = client.upload.mock.calls[0]?.[0]?.fundingMode;
    expect(mode).toBeInstanceOf(OnDemandFunding);
    expect(String((mode as InstanceType<typeof OnDemandFunding>).maxTokenAmount)).toBe('3');
  });

  it('refuses an above-ceiling upload by name when no spend ceiling is configured', async () => {
    // "No spend authority" and "your blob is malformed" must stay different
    // messages, and the refusal happens before any bytes reach Turbo.
    const client = stubClient();
    const adapter = createOnDemandUploadAdapter({
      client,
      signerKind: 'solana-ed25519',
      log: silentLog,
    });
    await expect(adapter.upload(BIG)).rejects.toThrow(/paid uploads are off/);
    await expect(adapter.upload(BIG)).rejects.toThrow(/STORE_TURBO_MAX_ARIO_PER_UPLOAD/);
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('measures the free tier on the signed data item, not the payload', async () => {
    // The MEDIUM from store#128's first review: Turbo applies the ceiling to
    // the signed ANS-104 item. A payload just under the ceiling overflows it
    // once the RSA envelope (~1 KiB) is added -- that must take the paid
    // route (or be refused), not be submitted unfunded and die as a T00.
    const boundaryPayload = Buffer.alloc(TURBO_FREE_TIER_MAX_BYTES - 500, 1);

    const client = stubClient();
    const rsa = createOnDemandUploadAdapter({
      client,
      signerKind: 'arweave-rsa',
      log: silentLog,
    });
    await expect(rsa.upload(boundaryPayload)).rejects.toThrow(/paid uploads are off/);
    expect(client.upload).not.toHaveBeenCalled();

    // The same payload under an ed25519 signer fits: its envelope is ~116 B.
    const client2 = stubClient();
    const solana = createOnDemandUploadAdapter({
      client: client2,
      signerKind: 'solana-ed25519',
      log: silentLog,
    });
    const result = await solana.upload(boundaryPayload);
    expect(result.txId).toBe('stub-tx');
    expect(client2.upload.mock.calls[0]?.[0]?.fundingMode).toBeUndefined();
  });

  it('tags count toward the signed size at the boundary', async () => {
    // Exactly at the ceiling with no tags = free; the same payload with tags
    // crosses it and must be paid for (or refused).
    const envelope = estimateDataItemBytes(0, 'solana-ed25519');
    const exactlyAtCeiling = Buffer.alloc(TURBO_FREE_TIER_MAX_BYTES - envelope, 1);

    const client = stubClient();
    const adapter = createOnDemandUploadAdapter({
      client,
      signerKind: 'solana-ed25519',
      log: silentLog,
    });
    await expect(adapter.upload(exactlyAtCeiling)).resolves.toEqual({ txId: 'stub-tx' });
    await expect(
      adapter.upload(exactlyAtCeiling, { 'Content-Type': 'application/octet-stream' })
    ).rejects.toThrow(/paid uploads are off/);
  });

  it('estimateDataItemBytes counts envelope and tags', () => {
    expect(estimateDataItemBytes(1000, 'solana-ed25519')).toBe(1000 + 116);
    expect(estimateDataItemBytes(1000, 'arweave-rsa')).toBe(1000 + 1044);
    const withTags = estimateDataItemBytes(1000, 'solana-ed25519', {
      'Content-Type': 'application/octet-stream',
    });
    expect(withTags).toBeGreaterThan(1000 + 116 + 30);
    expect(withTags).toBeLessThan(1000 + 116 + 60);
  });

  it('a paid upload is announced in the log with its bound (the audit line)', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const client = stubClient();
    const adapter = createOnDemandUploadAdapter({
      client,
      signerKind: 'solana-ed25519',
      maxArioPerUpload: 5,
      log,
      createFundingMode: async () => ({}),
    });
    await adapter.upload(BIG);
    const lines = log.info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('paid upload') && l.includes('5 $ARIO'))).toBe(true);
    // ...and a free-tier upload is not.
    log.info.mockClear();
    await adapter.upload(SMALL);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('propagates the ceiling breach from turbo-sdk instead of retrying or absorbing it', async () => {
    // OnDemandFunding throws rather than spending above maxTokenAmount; the
    // adapter must surface that, not loop.
    const client: TurboOnDemandClient & { upload: ReturnType<typeof vi.fn> } = {
      upload: vi.fn(async () => {
        throw new Error('fund amount exceeds maxTokenAmount');
      }),
    };
    const adapter = createOnDemandUploadAdapter({
      client,
      signerKind: 'solana-ed25519',
      maxArioPerUpload: 1,
      log: silentLog,
      createFundingMode: async () => ({}),
    });
    await expect(adapter.upload(BIG)).rejects.toThrow(/maxTokenAmount/);
    expect(client.upload).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Secret non-disclosure — asserted statically, the way the repo already does
// for its deploy bundle: no log line in the funding path may interpolate the
// funding secret. The funding module never receives the key at all (it takes
// a constructed client), and the entrypoint must not log the variable.
// ---------------------------------------------------------------------------

describe('the funding secret is never logged', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));

  it('turbo-funding.ts never touches the key variable', () => {
    const source = readFileSync(`${repoRoot}src/turbo-funding.ts`, 'utf8');
    expect(source).not.toContain("env['STORE_TURBO_SOLANA_KEY']");
  });

  it('entrypoint-store.ts never interpolates the key into a log call', () => {
    // Scan the WHOLE call expression, not just the line the `console.` sits
    // on: most of the entrypoint's log calls put their template literal on a
    // continuation line, which a per-line scan is blind to (store#128 review).
    const source = readFileSync(`${repoRoot}src/entrypoint-store.ts`, 'utf8');
    const calls = extractCallExpressions(source, /console\.(log|warn|error)\s*\(/g);
    expect(calls.length).toBeGreaterThan(10); // the scan must actually see them
    for (const call of calls) {
      expect(
        call,
        `log call must not mention the raw key: ${call.slice(0, 120)}`
      ).not.toMatch(/\$\{(solanaKey|turboSolanaKey|secretB58)/);
    }
  });

  it('the gateway URL is only ever logged through redactGatewayUrl', () => {
    // /health and the boot log leave the box; a raw gateway URL can carry the
    // RPC API key (store#128 second review, finding 1).
    const source = readFileSync(`${repoRoot}src/entrypoint-store.ts`, 'utf8');
    const calls = extractCallExpressions(source, /console\.(log|warn|error)\s*\(/g);
    for (const call of calls) {
      if (/gatewayUrl/.test(call)) {
        expect(
          call,
          `gateway must be redacted in: ${call.slice(0, 120)}`
        ).toMatch(/redactGatewayUrl\s*\(/);
      }
    }
  });
});

/**
 * Every span from a match of `open` to its balancing close paren. Parens
 * inside quotes/backticks are skipped so a ")" in a message cannot end the
 * span early; good enough for the entrypoint's actual log calls.
 */
function extractCallExpressions(source: string, open: RegExp): string[] {
  const spans: string[] = [];
  for (const match of source.matchAll(open)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote: string | null = null;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (quote !== null) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
    }
    spans.push(source.slice(start, i));
  }
  return spans;
}
