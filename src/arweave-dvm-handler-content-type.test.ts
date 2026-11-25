import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { createArweaveDvmHandler } from './arweave-dvm-handler.js';
import { ChunkManager } from './chunk-manager.js';
import type { StoreHandlerContext } from './store-backend.js';

// Store-side addition beside the moved sdk tests in arweave-dvm-handler.test.ts.
describe('createArweaveDvmHandler content type', () => {
  it('sanitizes a hostile content type', async () => {
    const adapter = { upload: vi.fn(async () => ({ txId: 'tx-1' })) };
    const handler = createArweaveDvmHandler({
      turboAdapter: adapter,
      chunkManager: new ChunkManager(),
    });
    const event = buildBlobStorageRequest(
      { blobData: Buffer.from('x'), bid: '1', contentType: 'text/html\r\nX-Evil: 1' },
      generateSecretKey()
    );
    const ctx: StoreHandlerContext = {
      toon: '',
      kind: 5094,
      pubkey: 'p',
      amount: 0n,
      destination: 'g.test',
      decode: () => event,
      accept: (metadata) => ({ accept: true, ...(metadata ? { metadata } : {}) }),
      reject: (code, message) => ({ accept: false, code, message }),
    };
    await handler(ctx);
    expect(adapter.upload.mock.calls[0]?.[1]).toMatchObject({
      'Content-Type': 'application/octet-stream',
    });
  });
});
