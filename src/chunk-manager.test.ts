/**
 * ATDD tests for Story 8.0: Chunk State Manager
 *
 * Test IDs: 8.0-UNIT-007, 8.0-UNIT-008, 8.0-UNIT-009, 8.0-UNIT-010, 8.0-UNIT-011
 *
 * AC covered:
 * - AC #8: Chunk splitting
 * - AC #9: Chunk accumulation
 * - AC #10: Chunk timeout
 * - AC #11: Chunk edge cases (duplicates, out-of-order, memory cap, totalChunks mismatch)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ChunkManager } from './chunk-manager.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createChunkData(content: string): Buffer {
  return Buffer.from(content);
}

// ============================================================================
// 8.0-UNIT-007: Sequential Chunks -> Complete (AC #9)
// ============================================================================

describe('ChunkManager (Story 8.0)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Sequential chunk accumulation (8.0-UNIT-007)', () => {
    it('[P0] sequential chunks -> complete: true on last chunk, assembled contains concatenated data', () => {
      // Arrange
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 100,
      });
      const uploadId = 'upload-001';
      const chunk0 = createChunkData('chunk-0-data');
      const chunk1 = createChunkData('chunk-1-data');
      const chunk2 = createChunkData('chunk-2-data');

      // Act
      const r0 = manager.addChunk(uploadId, 0, 3, chunk0);
      const r1 = manager.addChunk(uploadId, 1, 3, chunk1);
      const r2 = manager.addChunk(uploadId, 2, 3, chunk2);

      // Assert
      expect(r0.complete).toBe(false);
      expect(r1.complete).toBe(false);
      expect(r2.complete).toBe(true);
      expect(r2.assembled).toBeDefined();
      expect(r2.assembled!.toString()).toBe(
        'chunk-0-datachunk-1-datachunk-2-data'
      );
    });
  });

  // ==========================================================================
  // 8.0-UNIT-008: Out-of-Order Chunks (AC #11)
  // ==========================================================================

  describe('Out-of-order chunk handling (8.0-UNIT-008)', () => {
    it('[P0] out-of-order chunks -> accepted, assembled in correct order', () => {
      // Arrange
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 100,
      });
      const uploadId = 'upload-002';
      const chunk0 = createChunkData('AAAA');
      const chunk1 = createChunkData('BBBB');
      const chunk2 = createChunkData('CCCC');

      // Act: send chunks out of order (2, 0, 1)
      const r2 = manager.addChunk(uploadId, 2, 3, chunk2);
      const r0 = manager.addChunk(uploadId, 0, 3, chunk0);
      const r1 = manager.addChunk(uploadId, 1, 3, chunk1);

      // Assert: assembled in correct index order (0, 1, 2)
      expect(r2.complete).toBe(false);
      expect(r0.complete).toBe(false);
      expect(r1.complete).toBe(true);
      expect(r1.assembled!.toString()).toBe('AAAABBBBCCCC');
    });
  });

  // ==========================================================================
  // 8.0-UNIT-009: Duplicate Chunk Rejection (AC #11)
  // ==========================================================================

  describe('Duplicate chunk rejection (8.0-UNIT-009)', () => {
    it('[P0] duplicate chunkIndex -> rejected', () => {
      // Arrange
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 100,
      });
      const uploadId = 'upload-003';
      const chunk0 = createChunkData('data-0');

      // Act
      const r0 = manager.addChunk(uploadId, 0, 3, chunk0);

      // Assert: first add succeeds
      expect(r0.complete).toBe(false);
      // Second add should throw
      expect(() => manager.addChunk(uploadId, 0, 3, chunk0)).toThrow(
        /Duplicate chunkIndex/
      );
    });
  });

  // ==========================================================================
  // 8.0-UNIT-010: Timeout Discards Partial Data (AC #10)
  // ==========================================================================

  describe('Timeout cleanup (8.0-UNIT-010)', () => {
    it('[P0] timeout -> cleanup discards partial data', () => {
      // Arrange
      const manager = new ChunkManager({
        timeoutMs: 5000,
        maxActiveUploads: 100,
      });
      const uploadId = 'upload-004';
      const chunk0 = createChunkData('partial-data');

      // Act: add one chunk, then advance time past timeout
      manager.addChunk(uploadId, 0, 3, chunk0);
      vi.advanceTimersByTime(6000); // past the 5s timeout

      // Assert: upload should be discarded
      expect(manager.isComplete(uploadId)).toBe(false);
      // Adding chunk 0 again should work (state was cleaned up, starts fresh)
      const r = manager.addChunk(uploadId, 0, 3, createChunkData('new-data'));
      expect(r.complete).toBe(false);
    });
  });

  // ==========================================================================
  // Mismatched totalChunks (AC #11 edge case)
  // ==========================================================================

  describe('Mismatched totalChunks for same uploadId (AC #11)', () => {
    it('[P1] second chunk with different totalChunks uses the first chunks totalChunks', () => {
      // Arrange: first chunk says totalChunks=3
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 100,
      });
      const uploadId = 'upload-mismatch';
      manager.addChunk(uploadId, 0, 3, createChunkData('AAA'));

      // Act: second chunk says totalChunks=5, but state was set to 3 by first chunk
      manager.addChunk(uploadId, 1, 5, createChunkData('BBB'));
      const r2 = manager.addChunk(uploadId, 2, 3, createChunkData('CCC'));

      // Assert: completes at 3 chunks (the original totalChunks), not 5
      expect(r2.complete).toBe(true);
      expect(r2.assembled!.toString()).toBe('AAABBBCCC');
    });
  });

  // ==========================================================================
  // 8.0-UNIT-011: Memory Cap (AC #11)
  // ==========================================================================

  describe('Memory cap enforcement (8.0-UNIT-011)', () => {
    it('[P0] rejects new uploadIds when memory cap reached', () => {
      // Arrange: cap at 2 active uploads
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 2,
      });

      // Act: fill up to cap
      manager.addChunk('upload-A', 0, 5, createChunkData('a'));
      manager.addChunk('upload-B', 0, 5, createChunkData('b'));

      // Assert: third upload should be rejected
      expect(() =>
        manager.addChunk('upload-C', 0, 5, createChunkData('c'))
      ).toThrow(/Max active uploads/);
    });

    it('[P1] existing uploadId does not count against cap when adding more chunks', () => {
      // Arrange: cap at 2, fill both slots
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 2,
      });
      manager.addChunk('upload-A', 0, 5, createChunkData('a'));
      manager.addChunk('upload-B', 0, 5, createChunkData('b'));

      // Act: adding another chunk to an existing uploadId should work
      const result = manager.addChunk('upload-A', 1, 5, createChunkData('a2'));

      // Assert: accepted (same uploadId, not a new upload)
      expect(result.complete).toBe(false);
    });

    it('[P1] cleanup frees a slot for new uploads', () => {
      // Arrange
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 2,
      });
      manager.addChunk('upload-A', 0, 5, createChunkData('a'));
      manager.addChunk('upload-B', 0, 5, createChunkData('b'));

      // Act: clean up one upload, then add a new one
      manager.cleanup('upload-A');

      // Assert: new upload should be accepted
      const result = manager.addChunk('upload-C', 0, 5, createChunkData('c'));
      expect(result.complete).toBe(false); // accepted, not complete
    });
  });

  // ==========================================================================
  // Per-upload byte limit
  // ==========================================================================

  describe('Per-upload byte limit', () => {
    it('[P0] rejects chunk that would exceed maxBytesPerUpload and cleans up upload', () => {
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 100,
        maxBytesPerUpload: 100, // 100 bytes limit
      });
      const uploadId = 'upload-byte-limit';

      // First chunk: 60 bytes, under limit
      manager.addChunk(uploadId, 0, 3, createChunkData('A'.repeat(60)));

      // Second chunk: 60 bytes, would push total to 120 > 100
      expect(() =>
        manager.addChunk(uploadId, 1, 3, createChunkData('B'.repeat(60)))
      ).toThrow(/exceeds max bytes per upload/);

      // Upload should be cleaned up after rejection -- can start fresh
      const r = manager.addChunk(uploadId, 0, 3, createChunkData('C'));
      expect(r.complete).toBe(false);
    });
  });

  // ==========================================================================
  // chunkIndex bounds validation
  // ==========================================================================

  describe('chunkIndex bounds validation', () => {
    it('[P0] chunkIndex >= totalChunks -> rejected', () => {
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 100,
      });
      expect(() =>
        manager.addChunk('upload-bounds', 5, 5, createChunkData('data'))
      ).toThrow(/chunkIndex 5 out of bounds/);
    });

    it('[P0] negative chunkIndex -> rejected', () => {
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 100,
      });
      expect(() =>
        manager.addChunk('upload-neg', -1, 5, createChunkData('data'))
      ).toThrow(/chunkIndex -1 out of bounds/);
    });
  });

  // ==========================================================================
  // destroyAll cleanup
  // ==========================================================================

  describe('destroyAll() cleanup', () => {
    it('[P0] destroyAll clears all active uploads and timers', () => {
      const manager = new ChunkManager({
        timeoutMs: 300_000,
        maxActiveUploads: 100,
      });
      manager.addChunk('upload-X', 0, 3, createChunkData('x'));
      manager.addChunk('upload-Y', 0, 3, createChunkData('y'));

      // Act
      manager.destroyAll();

      // Assert: uploads are gone, can re-add with same IDs
      expect(manager.isComplete('upload-X')).toBe(false);
      expect(manager.isComplete('upload-Y')).toBe(false);
      // New upload should work (not blocked by cap)
      const r = manager.addChunk('upload-X', 0, 3, createChunkData('new'));
      expect(r.complete).toBe(false);
    });
  });
});
