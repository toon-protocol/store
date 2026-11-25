/**
 * ATDD tests for Story 8.0: Arweave DVM Handler
 *
 * Test IDs: 8.0-UNIT-004, 8.0-UNIT-005, 8.0-UNIT-006
 *
 * AC covered:
 * - AC #5: Single-packet upload (prepaid)
 * - AC #9: Chunk accumulation -> upload
 */

import { describe, it, expect, vi } from 'vitest';

import { createArweaveDvmHandler } from './arweave-dvm-handler.js';
import type { ArweaveUploadAdapter } from './turbo-adapter.js';
import type { ChunkManager } from './chunk-manager.js';
import type { StoreHandlerContext as HandlerContext } from './store-backend.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock ArweaveUploadAdapter for testing.
 */
function createMockTurboAdapter(): ArweaveUploadAdapter & {
  upload: ReturnType<typeof vi.fn>;
} {
  return {
    upload: vi.fn().mockResolvedValue({ txId: 'mock-arweave-tx-id-abc123' }),
  };
}

/**
 * Creates a mock ChunkManager for testing.
 */
function createMockChunkManager() {
  return {
    addChunk: vi.fn().mockReturnValue({ complete: false }),
    isComplete: vi.fn().mockReturnValue(false),
    cleanup: vi.fn(),
  } as unknown as ChunkManager & {
    addChunk: ReturnType<typeof vi.fn>;
    isComplete: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
  };
}

/**
 * Creates a minimal mock HandlerContext.
 */
function createMockHandlerContext(
  overrides: Partial<HandlerContext> = {}
): HandlerContext {
  const defaults: HandlerContext = {
    toon: 'mock-toon-string',
    kind: 5094,
    pubkey: 'ab'.repeat(32),
    amount: 1000000n,
    destination: 'g.toon.provider',
    decode: vi.fn().mockReturnValue({
      id: 'a'.repeat(64),
      pubkey: 'ab'.repeat(32),
      kind: 5094,
      content: '',
      tags: [
        ['i', Buffer.from('hello world').toString('base64'), 'blob'],
        ['bid', '1000000', 'usdc'],
        ['output', 'application/octet-stream'],
      ],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    }),
    accept: vi.fn().mockReturnValue({ accept: true }),
    reject: vi
      .fn()
      .mockReturnValue({ accept: false, code: 'F00', message: 'rejected' }),
  };

  return { ...defaults, ...overrides };
}

// ============================================================================
// 8.0-UNIT-004: Single-Packet Upload (AC #5)
// ============================================================================

describe('Arweave DVM Handler (Story 8.0)', () => {
  describe('Single-packet upload (8.0-UNIT-004)', () => {
    it('[P0] valid single-packet request -> calls turboAdapter.upload -> returns txId in accept data', async () => {
      // Arrange
      const turboAdapter = createMockTurboAdapter();
      const chunkManager = createMockChunkManager();
      const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
      const ctx = createMockHandlerContext();

      // Act
      const result = await handler(ctx);

      // Assert
      expect(turboAdapter.upload).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        accept: true,
        data: Buffer.from('mock-arweave-tx-id-abc123').toString('base64'),
      });
    });

    it('[P0] returns { accept: true, data: txId } directly -- NOT via ctx.accept()', async () => {
      // Arrange
      const turboAdapter = createMockTurboAdapter();
      const chunkManager = createMockChunkManager();
      const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
      const ctx = createMockHandlerContext();

      // Act
      const result = await handler(ctx);

      // Assert: data field is set (not metadata)
      expect(result.accept).toBe(true);
      expect((result as { accept: true; data?: string }).data).toBe(
        Buffer.from('mock-arweave-tx-id-abc123').toString('base64')
      );
      // ctx.accept should NOT be called -- handler returns directly
      expect(ctx.accept).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 8.0-UNIT-005: Malformed Event Rejection (AC #5)
  // ==========================================================================

  describe('Malformed event rejection (8.0-UNIT-005)', () => {
    it('[P0] malformed event (bad parse) -> rejects with error', async () => {
      // Arrange: event with no i tag -> parseBlobStorageRequest returns null
      const turboAdapter = createMockTurboAdapter();
      const chunkManager = createMockChunkManager();
      const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
      const ctx = createMockHandlerContext({
        decode: vi.fn().mockReturnValue({
          id: 'a'.repeat(64),
          pubkey: 'ab'.repeat(32),
          kind: 5094,
          content: '',
          tags: [], // no i tag -> parse returns null
          created_at: Math.floor(Date.now() / 1000),
          sig: '0'.repeat(128),
        }),
      });

      // Act
      const result = await handler(ctx);

      // Assert: rejected, no upload
      expect(result.accept).toBe(false);
      expect(turboAdapter.upload).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Upload Error Handling (AC #5)
  // ==========================================================================

  describe('Upload error handling (AC #5)', () => {
    it('[P0] turboAdapter.upload failure -> rejects with T00 error', async () => {
      // Arrange
      const turboAdapter = createMockTurboAdapter();
      turboAdapter.upload.mockRejectedValue(
        new Error('Arweave gateway timeout')
      );
      const chunkManager = createMockChunkManager();
      const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
      const ctx = createMockHandlerContext();

      // Act
      const result = await handler(ctx);

      // Assert
      expect(result.accept).toBe(false);
      expect((result as { code?: string }).code).toBe('T00');
      expect((result as { message?: string }).message).toContain(
        'Arweave upload failed'
      );
    });

    it('[P0] passes Content-Type tag to turboAdapter.upload', async () => {
      // Arrange
      const turboAdapter = createMockTurboAdapter();
      const chunkManager = createMockChunkManager();
      const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
      const ctx = createMockHandlerContext({
        decode: vi.fn().mockReturnValue({
          id: 'a'.repeat(64),
          pubkey: 'ab'.repeat(32),
          kind: 5094,
          content: '',
          tags: [
            ['i', Buffer.from('test-data').toString('base64'), 'blob'],
            ['bid', '500000', 'usdc'],
            ['output', 'image/png'],
          ],
          created_at: Math.floor(Date.now() / 1000),
          sig: '0'.repeat(128),
        }),
      });

      // Act
      await handler(ctx);

      // Assert: verify Content-Type tag was passed
      expect(turboAdapter.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ 'Content-Type': 'image/png' })
      );
    });

    it('[P0] event Content-Type takes precedence over arweaveTags Content-Type', async () => {
      // Arrange: arweaveTags has a default Content-Type, but the event specifies image/png
      const turboAdapter = createMockTurboAdapter();
      const chunkManager = createMockChunkManager();
      const handler = createArweaveDvmHandler({
        turboAdapter,
        chunkManager,
        arweaveTags: {
          'Content-Type': 'application/default',
          'App-Name': 'TOON',
        },
      });
      const ctx = createMockHandlerContext({
        decode: vi.fn().mockReturnValue({
          id: 'a'.repeat(64),
          pubkey: 'ab'.repeat(32),
          kind: 5094,
          content: '',
          tags: [
            ['i', Buffer.from('test-data').toString('base64'), 'blob'],
            ['bid', '500000', 'usdc'],
            ['output', 'image/png'],
          ],
          created_at: Math.floor(Date.now() / 1000),
          sig: '0'.repeat(128),
        }),
      });

      // Act
      await handler(ctx);

      // Assert: event's image/png wins over config's application/default
      expect(turboAdapter.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          'Content-Type': 'image/png',
          'App-Name': 'TOON',
        })
      );
    });

    it('[P1] arweaveTags config merged into upload tags', async () => {
      // Arrange
      const turboAdapter = createMockTurboAdapter();
      const chunkManager = createMockChunkManager();
      const handler = createArweaveDvmHandler({
        turboAdapter,
        chunkManager,
        arweaveTags: { 'App-Name': 'TOON', 'App-Version': '1.0' },
      });
      const ctx = createMockHandlerContext();

      // Act
      await handler(ctx);

      // Assert: verify custom tags merged with Content-Type
      expect(turboAdapter.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          'Content-Type': 'application/octet-stream',
          'App-Name': 'TOON',
          'App-Version': '1.0',
        })
      );
    });
  });

  // ==========================================================================
  // Chunk Manager Errors Through Handler (AC #9, #11)
  // ==========================================================================

  describe('Chunk manager errors through handler (AC #9, #11)', () => {
    it('[P0] duplicate chunk through handler -> rejects with F00', async () => {
      // Arrange
      const turboAdapter = createMockTurboAdapter();
      const chunkManager = createMockChunkManager();
      chunkManager.addChunk.mockImplementation(() => {
        throw new Error('Duplicate chunkIndex 2 for uploadId test-id');
      });
      const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
      const ctx = createMockHandlerContext({
        decode: vi.fn().mockReturnValue({
          id: 'a'.repeat(64),
          pubkey: 'ab'.repeat(32),
          kind: 5094,
          content: '',
          tags: [
            ['i', Buffer.from('chunk-data').toString('base64'), 'blob'],
            ['bid', '100000', 'usdc'],
            ['output', 'application/octet-stream'],
            ['param', 'uploadId', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'],
            ['param', 'chunkIndex', '2'],
            ['param', 'totalChunks', '5'],
          ],
          created_at: Math.floor(Date.now() / 1000),
          sig: '0'.repeat(128),
        }),
      });

      // Act
      const result = await handler(ctx);

      // Assert
      expect(result.accept).toBe(false);
      expect((result as { message?: string }).message).toContain(
        'Duplicate chunk rejected'
      );
      expect(turboAdapter.upload).not.toHaveBeenCalled();
    });

    it('[P1] upload failure on assembled chunks -> rejects with F00', async () => {
      // Arrange
      const turboAdapter = createMockTurboAdapter();
      turboAdapter.upload.mockRejectedValue(new Error('Upload failed'));
      const chunkManager = createMockChunkManager();
      chunkManager.addChunk.mockReturnValue({
        complete: true,
        assembled: Buffer.from('assembled-data'),
      });
      const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
      const ctx = createMockHandlerContext({
        decode: vi.fn().mockReturnValue({
          id: 'a'.repeat(64),
          pubkey: 'ab'.repeat(32),
          kind: 5094,
          content: '',
          tags: [
            ['i', Buffer.from('last-chunk').toString('base64'), 'blob'],
            ['bid', '100000', 'usdc'],
            ['output', 'application/octet-stream'],
            ['param', 'uploadId', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'],
            ['param', 'chunkIndex', '4'],
            ['param', 'totalChunks', '5'],
          ],
          created_at: Math.floor(Date.now() / 1000),
          sig: '0'.repeat(128),
        }),
      });

      // Act
      const result = await handler(ctx);

      // Assert
      expect(result.accept).toBe(false);
      expect((result as { message?: string }).message).toContain(
        'Chunk processing error'
      );
    });
  });

  // ==========================================================================
  // 8.0-UNIT-006: Chunked Upload (AC #9)
  // ==========================================================================

  describe('Chunked upload handling (8.0-UNIT-006)', () => {
    it('[P0] intermediate chunk -> returns ack:<chunkIndex>', async () => {
      // Arrange: chunk 2 of 5, not yet complete
      const turboAdapter = createMockTurboAdapter();
      const chunkManager = createMockChunkManager();
      chunkManager.addChunk.mockReturnValue({ complete: false });
      const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
      const ctx = createMockHandlerContext({
        decode: vi.fn().mockReturnValue({
          id: 'a'.repeat(64),
          pubkey: 'ab'.repeat(32),
          kind: 5094,
          content: '',
          tags: [
            ['i', Buffer.from('chunk-data').toString('base64'), 'blob'],
            ['bid', '100000', 'usdc'],
            ['output', 'application/octet-stream'],
            ['param', 'uploadId', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
            ['param', 'chunkIndex', '2'],
            ['param', 'totalChunks', '5'],
          ],
          created_at: Math.floor(Date.now() / 1000),
          sig: '0'.repeat(128),
        }),
      });

      // Act
      const result = await handler(ctx);

      // Assert: accepted with ack, no upload
      expect(result).toEqual({
        accept: true,
        data: Buffer.from('ack:2').toString('base64'),
      });
      expect(turboAdapter.upload).not.toHaveBeenCalled();
    });

    it('[P0] final chunk (all received) -> uploads assembled blob -> returns txId', async () => {
      // Arrange: last chunk completes the upload
      const turboAdapter = createMockTurboAdapter();
      const chunkManager = createMockChunkManager();
      const assembledBlob = Buffer.from('full-assembled-blob-data');
      chunkManager.addChunk.mockReturnValue({
        complete: true,
        assembled: assembledBlob,
      });
      const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
      const ctx = createMockHandlerContext({
        decode: vi.fn().mockReturnValue({
          id: 'a'.repeat(64),
          pubkey: 'ab'.repeat(32),
          kind: 5094,
          content: '',
          tags: [
            ['i', Buffer.from('last-chunk').toString('base64'), 'blob'],
            ['bid', '100000', 'usdc'],
            ['output', 'application/octet-stream'],
            ['param', 'uploadId', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
            ['param', 'chunkIndex', '4'],
            ['param', 'totalChunks', '5'],
          ],
          created_at: Math.floor(Date.now() / 1000),
          sig: '0'.repeat(128),
        }),
      });

      // Act
      const result = await handler(ctx);

      // Assert: uploaded assembled blob, returned txId
      expect(turboAdapter.upload).toHaveBeenCalledWith(
        assembledBlob,
        expect.any(Object)
      );
      expect(result).toEqual({
        accept: true,
        data: Buffer.from('mock-arweave-tx-id-abc123').toString('base64'),
      });
    });
  });
});
