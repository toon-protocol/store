/**
 * Unit tests for the kind:5095 ArNS brokered-buy ("buyfor") handler.
 *
 * HARD SAFETY RULE: every test drives an injected stub SDK — no test ever
 * touches the live ar.io registry or spends real (or even devnet) $ARIO.
 *
 * Covers:
 *   - parseArnsBuyParams: param-tag parsing + validation
 *   - createArnsBuyHandler: quote → buyRecord(processId) → syncAttributes
 *     flow, receipt shape, non-fatal sync failure, rejections, lazy SDK
 *     load retry
 *   - startStoreBackend dispatch: kind:5095 routed to its handler and the
 *     JSON receipt surfaced as `result`, while kind:5094 keeps `txId`
 *   - resolveArnsBuyEnv: enable/disable/validation
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  ARNS_BUY_KIND,
  createArnsBuyHandler,
  parseArnsBuyParams,
  type ArnsBuySdk,
  type ArnsBuyReceipt,
} from './arns-buy-handler.js';
import {
  startStoreBackend,
  type StoreHandler,
  type StoreHandlerContext,
} from './store-backend.js';
import { resolveArnsBuyEnv } from './entrypoint-store.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A plausible base58 Solana pubkey (the client's ANT asset address). */
const CLIENT_ANT = 'JE8M2FWAFqTVTr3PKLxZ81PuZUKSa2y6h2EbiuATr7H9';

function buyEvent(params: Record<string, string>, kind = ARNS_BUY_KIND): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'b'.repeat(64),
    sig: 'c'.repeat(128),
    kind,
    created_at: 1_700_000_000,
    content: '',
    tags: Object.entries(params).map(([k, v]) => ['param', k, v]),
  };
}

function ctxFor(event: NostrEvent): StoreHandlerContext {
  return {
    toon: '',
    kind: event.kind,
    pubkey: event.pubkey,
    amount: 0n,
    destination: 'g.connector.store',
    decode: () => event,
    accept: (metadata) => ({ accept: true, ...(metadata ? { metadata } : {}) }),
    reject: (code, message) => ({ accept: false, code, message }),
  };
}

function stubSdk(overrides: Partial<ArnsBuySdk> = {}): ArnsBuySdk {
  return {
    getTokenCost: vi.fn(async () => 2_291_718_480n),
    buyRecord: vi.fn(async () => ({ id: 'registry-tx-sig' })),
    syncAttributes: vi.fn(async () => ({ id: 'sync-tx-sig' })),
    ...overrides,
  };
}

const SECRET = new Uint8Array(64).fill(7);

function handlerWith(sdk: ArnsBuySdk) {
  return createArnsBuyHandler({
    network: 'devnet',
    solanaSecretKey: SECRET,
    loadSdk: vi.fn(async () => sdk),
  });
}

/** Decode an accepted response's base64 JSON receipt. */
function decodeReceipt(res: { accept: boolean; data?: string }): ArnsBuyReceipt {
  expect(res.accept).toBe(true);
  expect(res.data).toBeTypeOf('string');
  return JSON.parse(Buffer.from(res.data!, 'base64').toString('utf8'));
}

// ── parseArnsBuyParams ──────────────────────────────────────────────────────

describe('parseArnsBuyParams', () => {
  it('parses a minimal lease job (type + years defaulted)', () => {
    const params = parseArnsBuyParams(
      buyEvent({ name: 'toon-buyfor-e2e', processId: CLIENT_ANT })
    );
    expect(params).toEqual({
      name: 'toon-buyfor-e2e',
      type: 'lease',
      years: 1,
      processId: CLIENT_ANT,
    });
  });

  it('parses an explicit multi-year lease', () => {
    const params = parseArnsBuyParams(
      buyEvent({ name: 'abc', type: 'lease', years: '3', processId: CLIENT_ANT })
    );
    expect(params.years).toBe(3);
  });

  it('parses a permabuy (no years)', () => {
    const params = parseArnsBuyParams(
      buyEvent({ name: 'abc', type: 'permabuy', processId: CLIENT_ANT })
    );
    expect(params).toEqual({ name: 'abc', type: 'permabuy', processId: CLIENT_ANT });
  });

  it.each([
    [{ processId: CLIENT_ANT }, /missing required param.*name/],
    [{ name: 'Bad_Name', processId: CLIENT_ANT }, /invalid ArNS name/],
    [{ name: '-edge', processId: CLIENT_ANT }, /invalid ArNS name/],
    [{ name: 'a'.repeat(52), processId: CLIENT_ANT }, /invalid ArNS name/],
    [{ name: 'ok' }, /missing required param.*processId/],
    [{ name: 'ok', processId: 'not-base58!' }, /invalid processId/],
    [{ name: 'ok', processId: CLIENT_ANT, type: 'rental' }, /invalid type/],
    [{ name: 'ok', processId: CLIENT_ANT, years: '0' }, /invalid years/],
    [{ name: 'ok', processId: CLIENT_ANT, years: '6' }, /invalid years/],
    [{ name: 'ok', processId: CLIENT_ANT, years: '1.5' }, /invalid years/],
    [
      { name: 'ok', processId: CLIENT_ANT, type: 'permabuy', years: '1' },
      /years is not valid for a permabuy/,
    ],
  ])('rejects bad params %j', (params, message) => {
    expect(() => parseArnsBuyParams(buyEvent(params as Record<string, string>))).toThrow(
      message
    );
  });
});

// ── createArnsBuyHandler ────────────────────────────────────────────────────

describe('createArnsBuyHandler', () => {
  it('quotes, buys with the CLIENT ANT processId, syncs, and returns the receipt', async () => {
    const sdk = stubSdk();
    const handler = handlerWith(sdk);
    const res = await handler(
      ctxFor(buyEvent({ name: 'toon-buyfor-e2e', processId: CLIENT_ANT }))
    );

    const receipt = decodeReceipt(res as { accept: boolean; data?: string });
    expect(receipt).toEqual({
      job: 'arns-buy',
      network: 'devnet',
      name: 'toon-buyfor-e2e',
      type: 'lease',
      years: 1,
      processId: CLIENT_ANT,
      quotedMario: '2291718480',
      registryTxId: 'registry-tx-sig',
      syncAttributesTxId: 'sync-tx-sig',
    });

    expect(sdk.getTokenCost).toHaveBeenCalledWith({
      intent: 'Buy-Name',
      name: 'toon-buyfor-e2e',
      type: 'lease',
      years: 1,
    });
    // The load-bearing assertion of the whole design: the DVM's signer pays,
    // but the buy is bound to the CLIENT's ANT processId.
    expect(sdk.buyRecord).toHaveBeenCalledWith({
      name: 'toon-buyfor-e2e',
      type: 'lease',
      years: 1,
      processId: CLIENT_ANT,
    });
    expect(sdk.syncAttributes).toHaveBeenCalledWith({ name: 'toon-buyfor-e2e' });
  });

  it('a syncAttributes failure is non-fatal (receipt carries null sync tx)', async () => {
    const sdk = stubSdk({
      syncAttributes: vi.fn(async () => {
        throw new Error('sync exploded');
      }),
    });
    const handler = handlerWith(sdk);
    const res = await handler(
      ctxFor(buyEvent({ name: 'ok-name', processId: CLIENT_ANT }))
    );
    const receipt = decodeReceipt(res as { accept: boolean; data?: string });
    expect(receipt.registryTxId).toBe('registry-tx-sig');
    expect(receipt.syncAttributesTxId).toBeNull();
  });

  it('rejects a wrong-kind event with F00 (and never loads the SDK)', async () => {
    const loadSdk = vi.fn(async () => stubSdk());
    const handler = createArnsBuyHandler({
      network: 'devnet',
      solanaSecretKey: SECRET,
      loadSdk,
    });
    const res = await handler(
      ctxFor(buyEvent({ name: 'ok', processId: CLIENT_ANT }, 5094))
    );
    expect(res).toEqual({
      accept: false,
      code: 'F00',
      message: expect.stringContaining('expected kind:5095'),
    });
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('rejects invalid params with F00', async () => {
    const handler = handlerWith(stubSdk());
    const res = await handler(ctxFor(buyEvent({ name: 'Bad!' })));
    expect(res).toMatchObject({ accept: false, code: 'F00' });
  });

  it('rejects a failed buyRecord with T00 (quote succeeded, buy did not)', async () => {
    const sdk = stubSdk({
      buyRecord: vi.fn(async () => {
        throw new Error('insufficient ARIO balance');
      }),
    });
    const handler = handlerWith(sdk);
    const res = await handler(
      ctxFor(buyEvent({ name: 'ok-name', processId: CLIENT_ANT }))
    );
    expect(res).toEqual({
      accept: false,
      code: 'T00',
      message: expect.stringContaining('insufficient ARIO balance'),
    });
    expect(sdk.syncAttributes).not.toHaveBeenCalled();
  });

  it('a failed SDK load rejects the job but is retried on the next one', async () => {
    const sdk = stubSdk();
    const loadSdk = vi
      .fn<Parameters<NonNullable<Parameters<typeof createArnsBuyHandler>[0]['loadSdk']>>, Promise<ArnsBuySdk>>()
      .mockRejectedValueOnce(new Error('module not installed'))
      .mockResolvedValue(sdk);
    const handler = createArnsBuyHandler({
      network: 'devnet',
      solanaSecretKey: SECRET,
      loadSdk,
    });
    const event = buyEvent({ name: 'ok-name', processId: CLIENT_ANT });

    const first = await handler(ctxFor(event));
    expect(first).toMatchObject({ accept: false, code: 'T00' });

    const second = await handler(ctxFor(event));
    expect((second as { accept: boolean }).accept).toBe(true);
    expect(loadSdk).toHaveBeenCalledTimes(2);
  });
});

// ── startStoreBackend per-kind dispatch ─────────────────────────────────────

describe('startStoreBackend kind dispatch', () => {
  async function withBackend(
    handlers: { handle: StoreHandler; extra?: Record<number, StoreHandler> },
    run: (post: (event: NostrEvent) => Promise<Response>) => Promise<void>
  ): Promise<void> {
    const backend = startStoreBackend({
      handle: handlers.handle,
      ...(handlers.extra ? { handlers: handlers.extra } : {}),
      handlerPort: 0, // ephemeral
      devMode: true, // skip signature verification — fixture events are unsigned
    });
    // @hono/node-server's serve() returns a node http.Server (structurally).
    const address = (
      backend as unknown as { address(): { port: number } }
    ).address();
    const url = `http://127.0.0.1:${address.port}/store`;
    try {
      await run((event) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event }),
        })
      );
    } finally {
      await new Promise<void>((resolve) =>
        backend.close(() => resolve())
      );
    }
  }

  it('routes kind:5095 to its handler and surfaces the JSON receipt as `result`', async () => {
    const arweaveHandler: StoreHandler = vi.fn(async (ctx) =>
      ctx.reject('F00', 'should not be called')
    );
    const arnsHandler = handlerWith(stubSdk());
    await withBackend(
      { handle: arweaveHandler, extra: { [ARNS_BUY_KIND]: arnsHandler } },
      async (post) => {
        const res = await post(
          buyEvent({ name: 'toon-buyfor-e2e', processId: CLIENT_ANT })
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          accept: boolean;
          result?: ArnsBuyReceipt;
          txId?: string;
        };
        expect(body.accept).toBe(true);
        expect(body.txId).toBeUndefined();
        expect(body.result).toMatchObject({
          job: 'arns-buy',
          name: 'toon-buyfor-e2e',
          processId: CLIENT_ANT,
          registryTxId: 'registry-tx-sig',
        });
        expect(arweaveHandler).not.toHaveBeenCalled();
      }
    );
  });

  it('unregistered kinds still fall back to the default handler (txId contract)', async () => {
    const txId = 'A'.repeat(43);
    const arweaveHandler: StoreHandler = vi.fn(async () => ({
      accept: true as const,
      data: Buffer.from(txId, 'utf8').toString('base64'),
    }));
    const arnsHandler = handlerWith(stubSdk());
    await withBackend(
      { handle: arweaveHandler, extra: { [ARNS_BUY_KIND]: arnsHandler } },
      async (post) => {
        const res = await post(buyEvent({}, 5094));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { accept: boolean; txId?: string };
        expect(body.accept).toBe(true);
        expect(body.txId).toBe(txId);
      }
    );
  });
});

// ── resolveArnsBuyEnv ───────────────────────────────────────────────────────

describe('resolveArnsBuyEnv', () => {
  const HEX = 'ab'.repeat(64);

  it('disabled when the key is absent or empty/whitespace', () => {
    expect(resolveArnsBuyEnv({})).toBeUndefined();
    expect(resolveArnsBuyEnv({ ARNS_DVM_SOLANA_SECRET_KEY: '' })).toBeUndefined();
    expect(
      resolveArnsBuyEnv({ ARNS_DVM_SOLANA_SECRET_KEY: '  \n' })
    ).toBeUndefined();
  });

  it('defaults to devnet and decodes the 64-byte keypair', () => {
    const cfg = resolveArnsBuyEnv({ ARNS_DVM_SOLANA_SECRET_KEY: HEX });
    expect(cfg?.network).toBe('devnet');
    expect(cfg?.solanaSecretKey).toHaveLength(64);
    expect(cfg?.solanaSecretKey[0]).toBe(0xab);
  });

  it('mainnet is explicit opt-in', () => {
    expect(
      resolveArnsBuyEnv({
        ARNS_DVM_SOLANA_SECRET_KEY: HEX,
        ARNS_NETWORK: 'mainnet',
      })?.network
    ).toBe('mainnet');
  });

  it('throws on a malformed key or network', () => {
    expect(() =>
      resolveArnsBuyEnv({ ARNS_DVM_SOLANA_SECRET_KEY: 'deadbeef' })
    ).toThrow(/128-char hex/);
    expect(() =>
      resolveArnsBuyEnv({
        ARNS_DVM_SOLANA_SECRET_KEY: HEX,
        ARNS_NETWORK: 'testnet',
      })
    ).toThrow(/ARNS_NETWORK/);
  });
});
