/**
 * Unit tests for the payment-oblivious `POST /store` request-validation surface.
 *
 * Infra-free: the backend is started on an ephemeral port (`handlerPort: 0`) in
 * `devMode` (no signature verification) and driven with `fetch` — no network,
 * no Arweave, no db. The handler is a stub that never runs for malformed bodies.
 *
 * Regression: a non-object JSON body (`null`, a bare number/string) is *valid*
 * JSON, so `c.req.json()` does not throw; the body-shape guard must still route
 * it to the 422 "Invalid request body" path rather than dereferencing it and
 * escaping into a framework-level 500 (issue #50).
 */

import { describe, it, expect, vi } from 'vitest';
import { startStoreBackend, type StoreHandler } from './store-backend.js';

/** Start the backend, run against its ephemeral port, then close it. */
async function withBackend(
  handle: StoreHandler,
  run: (url: string) => Promise<void>
): Promise<void> {
  const backend = startStoreBackend({ handle, handlerPort: 0, devMode: true });
  const address = (
    backend as unknown as { address(): { port: number } }
  ).address();
  const url = `http://127.0.0.1:${address.port}/store`;
  try {
    await run(url);
  } finally {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
}

describe('POST /store request-body validation', () => {
  it.each([['null', 'null'], ['a bare number', '5'], ['a bare string', '"x"']])(
    'returns 422 F00 for %s body (never a 500 / uncaught throw)',
    async (_label, rawBody) => {
      const handle: StoreHandler = vi.fn(async (ctx) =>
        ctx.reject('F00', 'should not be called')
      );
      await withBackend(handle, async (url) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: rawBody,
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { accept: boolean; code: string };
        expect(body.accept).toBe(false);
        expect(body.code).toBe('F00');
        expect(handle).not.toHaveBeenCalled();
      });
    }
  );

  it('returns 422 F00 for a well-formed object missing `event`', async () => {
    const handle: StoreHandler = vi.fn(async (ctx) =>
      ctx.reject('F00', 'should not be called')
    );
    await withBackend(handle, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notEvent: true }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { accept: boolean; code: string };
      expect(body.code).toBe('F00');
      expect(handle).not.toHaveBeenCalled();
    });
  });
});
