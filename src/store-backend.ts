/**
 * Payment-oblivious plain-HTTP backend for the store (NIP-90 kind:5094 Arweave
 * blob storage).
 *
 * The connector runs in FRONT as a payment proxy: its `HttpProxyHandler`
 * terminates the payment on-chain and reverse-proxies a LITERAL HTTP request to
 * this backend's `upstream` (`http://store:<handlerPort>`), injecting the
 * trusted `X-TOON-Payer` / `X-TOON-Amount` / `X-TOON-Chain` headers
 * (RouteTermination — the same model as the relay's `POST /write`). By the time a
 * request reaches `POST /store` the payment is ALREADY proven, so this surface
 * contains NO ILP / claim / settlement logic — it verifies the event signature
 * for integrity, runs the Arweave upload handler, and returns a normal HTTP
 * response. The connector serializes that response back into the ILP FULFILL
 * `data` (it FULFILLs even on 5xx, so the client still observes the body).
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

/**
 * Minimal structural mirror of the SDK's `HandlerContext` / `HandlerResponse`.
 * Defined locally so this backend does not depend on a specific
 * `@toon-protocol/sdk` version re-exporting these types — the handler itself is
 * passed in by the entrypoint, already bound to the SDK's
 * `createArweaveDvmHandler`. The shapes match `@toon-protocol/core`'s
 * `HandlePacket{Accept,Reject}Response` and the SDK `HandlerContext`.
 */
export interface StoreHandlerContext {
  readonly toon: string;
  readonly kind: number;
  readonly pubkey: string;
  readonly amount: bigint;
  readonly destination: string;
  decode(): NostrEvent;
  accept(metadata?: Record<string, unknown>): {
    accept: true;
    data?: string;
    metadata?: Record<string, unknown>;
  };
  reject(code: string, message: string): { accept: false; code: string; message: string };
}

export type StoreHandlerResponse =
  | { accept: true; data?: string; metadata?: Record<string, unknown> }
  | { accept: false; code: string; message: string; metadata?: Record<string, unknown> };

export type StoreHandler = (ctx: StoreHandlerContext) => Promise<StoreHandlerResponse>;

export interface StoreBackendConfig {
  /**
   * The kind:5094 handler — typically `createArweaveDvmHandler(...)` wrapped by
   * the job counter, so /health (BLS, on blsPort) still reflects activity.
   * Fallback for kinds without an entry in {@link StoreBackendConfig.handlers}.
   */
  handle: StoreHandler;
  /**
   * Additional per-kind handlers (e.g. kind:5095 ArNS buy — see
   * ./arns-buy-handler). Dispatch is by the event's `kind`; kinds not listed
   * here fall back to `handle`.
   */
  handlers?: Record<number, StoreHandler>;
  /**
   * Plain-HTTP job port. The connector route's `upstream` points here
   * (`http://store:<handlerPort>`); the client request-target is `/store`.
   */
  handlerPort: number;
  /** Skip Schnorr signature verification (smoke only; mirrors the relay's devMode). */
  devMode: boolean;
}

export interface StoreBackend {
  close(cb?: (err?: Error) => void): void;
}

function safeBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/**
 * Start the payment-oblivious store job backend on `handlerPort`.
 *
 * Routes:
 *   GET  /health  — liveness on the job port (BLS health stays on blsPort)
 *   POST /store   — `{ event }` (signed kind:5094) → `{ accept, txId, ... }`
 */
export function startStoreBackend(config: StoreBackendConfig): StoreBackend {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.post('/store', async (c) => {
    // --- Parse request body ---
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ accept: false, code: 'F00', message: 'Invalid request body' }, 422);
    }
    // A non-object body (`null`, a bare `5` / `"x"`) is still valid JSON, so the
    // parse above does not throw — guard the shape before dereferencing `.event`,
    // or `null.event` escapes into a framework-level 500 (issue #50).
    if (body === null || typeof body !== 'object') {
      return c.json({ accept: false, code: 'F00', message: 'Invalid request body' }, 422);
    }
    const event = (body as { event?: NostrEvent }).event;
    if (!event) {
      return c.json({ accept: false, code: 'F00', message: 'Missing required field: event' }, 422);
    }

    // --- Capture trusted payment headers (NOT validated here) ---
    const payer = c.req.header('X-TOON-Payer');
    const amount = c.req.header('X-TOON-Amount');
    const chain = c.req.header('X-TOON-Chain');

    // --- Verify the event signature (integrity only; skipped in devMode) ---
    if (!config.devMode && !verifyEvent(event)) {
      return c.json({ accept: false, code: 'F00', message: 'Invalid event signature' }, 422);
    }

    // --- Drive the Arweave handler via a minimal payment-oblivious context ---
    // The Arweave handler only reads ctx.decode(); the remaining fields are
    // informational. amount/destination are echoed from the injected headers.
    const ctx: StoreHandlerContext = {
      toon: '',
      kind: event.kind,
      pubkey: event.pubkey,
      amount: amount ? safeBigInt(amount) : 0n,
      destination: 'g.connector.store',
      decode: () => event,
      accept: (metadata) => ({ accept: true, ...(metadata ? { metadata } : {}) }),
      reject: (code, message) => ({ accept: false, code, message }),
    };

    // Per-kind dispatch: registered kinds get their own handler; everything
    // else falls back to the default (kind:5094 Arweave) handler.
    const handle = config.handlers?.[event.kind] ?? config.handle;

    let res: StoreHandlerResponse;
    try {
      res = await handle(ctx);
    } catch (err) {
      console.error(
        '[store] handler threw:',
        err instanceof Error ? (err.stack ?? err.message) : err
      );
      return c.json({ accept: false, code: 'T00', message: 'Internal handler error' }, 502);
    }

    if (res.accept) {
      // The Arweave handler returns `data = base64(txId)`; structured handlers
      // (e.g. kind:5095 arns-buy) return `data = base64(JSON receipt)`. Decode
      // for a friendly JSON while echoing the base64 for byte-faithful
      // clients: a JSON object surfaces as `result`, anything else as `txId`
      // (the historical kind:5094 contract, unchanged).
      const decoded = res.data
        ? Buffer.from(res.data, 'base64').toString('utf8')
        : undefined;
      let txId: string | undefined;
      let result: Record<string, unknown> | undefined;
      if (decoded !== undefined) {
        try {
          const parsed: unknown = JSON.parse(decoded);
          if (parsed !== null && typeof parsed === 'object') {
            result = parsed as Record<string, unknown>;
          } else {
            txId = decoded;
          }
        } catch {
          txId = decoded;
        }
      }
      console.log(
        `[store] kind:${event.kind} id=${event.id} payer=${payer ?? '-'} ` +
          `amount=${amount ?? '-'} chain=${chain ?? '-'} -> ` +
          `${result ? `result=${decoded}` : `txId=${txId ?? '-'}`}`
      );
      return c.json(
        {
          accept: true,
          ...(txId !== undefined ? { txId } : {}),
          ...(result !== undefined ? { result } : {}),
          data: res.data,
          payer,
          amount,
          chain,
        },
        200
      );
    }

    // Rejection: surface code+message so the failure self-diagnoses from the
    // FULFILL body. F00 (malformed request) → 422; everything else → 502.
    console.warn(
      `[store] kind:${event.kind} id=${event.id} rejected: ${res.code} ${res.message}`
    );
    return c.json(
      { accept: false, code: res.code, message: res.message },
      res.code === 'F00' ? 422 : 502
    );
  });

  return serve({ fetch: app.fetch, port: config.handlerPort }) as unknown as StoreBackend;
}
