import { describe, it, expect, afterEach, vi } from 'vitest';
import { ChunkManager } from './chunk-manager.js';

describe('ChunkManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('assembles chunks in index order regardless of arrival order', () => {
    const cm = new ChunkManager();
    expect(cm.addChunk('u', 1, 3, Buffer.from('B'))).toEqual({ complete: false });
    expect(cm.addChunk('u', 2, 3, Buffer.from('C'))).toEqual({ complete: false });
    const done = cm.addChunk('u', 0, 3, Buffer.from('A'));
    expect(done.complete).toBe(true);
    expect(done.assembled?.toString()).toBe('ABC');
    expect(cm.isComplete('u')).toBe(false); // state cleaned up
  });

  it('rejects a duplicate chunk index', () => {
    const cm = new ChunkManager();
    cm.addChunk('u', 0, 2, Buffer.from('A'));
    expect(() => cm.addChunk('u', 0, 2, Buffer.from('A'))).toThrow(/Duplicate chunkIndex/);
    cm.destroyAll();
  });

  it('rejects an out-of-bounds chunk index', () => {
    const cm = new ChunkManager();
    expect(() => cm.addChunk('u', 2, 2, Buffer.from('A'))).toThrow(/out of bounds/);
    cm.destroyAll();
  });

  it('caps concurrent uploads', () => {
    const cm = new ChunkManager({ maxActiveUploads: 1 });
    cm.addChunk('a', 0, 2, Buffer.from('A'));
    expect(() => cm.addChunk('b', 0, 2, Buffer.from('A'))).toThrow(/Max active uploads/);
    cm.destroyAll();
  });

  it('caps bytes per upload and discards the upload', () => {
    const cm = new ChunkManager({ maxBytesPerUpload: 4 });
    cm.addChunk('u', 0, 3, Buffer.from('abc'));
    expect(() => cm.addChunk('u', 1, 3, Buffer.from('de'))).toThrow(/exceeds max bytes/);
    expect(cm.isComplete('u')).toBe(false);
  });

  it('discards a partial upload after the timeout', () => {
    vi.useFakeTimers();
    const cm = new ChunkManager({ timeoutMs: 1000, maxActiveUploads: 1 });
    cm.addChunk('a', 0, 2, Buffer.from('A'));
    vi.advanceTimersByTime(1001);
    // slot freed: a new uploadId is accepted
    expect(() => cm.addChunk('b', 0, 2, Buffer.from('A'))).not.toThrow();
    cm.destroyAll();
  });
});
