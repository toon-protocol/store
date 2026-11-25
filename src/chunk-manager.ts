/**
 * Chunk state manager for multi-packet blob uploads.
 *
 * Accumulates chunks for a given uploadId, assembles them in order
 * when all chunks have arrived, and enforces timeout and memory caps.
 */

export interface ChunkManagerConfig {
  /** Timeout in milliseconds before partial uploads are discarded (default: 300_000 = 5 min). */
  timeoutMs?: number;
  /** Maximum number of concurrent active uploads (default: 100). */
  maxActiveUploads?: number;
  /** Maximum total bytes accumulated per upload before rejection (default: 50MB). */
  maxBytesPerUpload?: number;
}

export interface AddChunkResult {
  /** Whether all chunks have been received and the blob is fully assembled. */
  complete: boolean;
  /** The assembled blob (only present when complete is true). */
  assembled?: Buffer;
  /** Error message if the chunk was rejected. */
  error?: string;
}

interface UploadState {
  chunks: Map<number, Buffer>;
  totalChunks: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages chunked upload state for the Arweave DVM handler.
 */
export class ChunkManager {
  private uploads = new Map<string, UploadState>();
  private readonly timeoutMs: number;
  private readonly maxActiveUploads: number;
  private readonly maxBytesPerUpload: number;

  constructor(config: ChunkManagerConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 300_000;
    this.maxActiveUploads = config.maxActiveUploads ?? 100;
    this.maxBytesPerUpload = config.maxBytesPerUpload ?? 50 * 1024 * 1024; // 50MB
  }

  /**
   * Add a chunk for a given uploadId.
   *
   * @param uploadId - Unique identifier for the upload session.
   * @param chunkIndex - Zero-based index of this chunk.
   * @param totalChunks - Total number of chunks expected.
   * @param data - The chunk data.
   * @returns Result indicating completion status or error.
   * @throws Error if memory cap reached or duplicate chunk.
   */
  addChunk(
    uploadId: string,
    chunkIndex: number,
    totalChunks: number,
    data: Buffer
  ): AddChunkResult {
    let state = this.uploads.get(uploadId);

    if (!state) {
      // Check memory cap before creating new upload
      if (this.uploads.size >= this.maxActiveUploads) {
        throw new Error(
          `Max active uploads reached (${this.maxActiveUploads}). Cannot accept new uploadId.`
        );
      }

      // Create new upload state with timeout
      const timer = setTimeout(() => {
        this.cleanup(uploadId);
      }, this.timeoutMs);

      state = {
        chunks: new Map(),
        totalChunks,
        timer,
      };
      this.uploads.set(uploadId, state);
    }

    // Validate chunkIndex is within bounds
    if (chunkIndex < 0 || chunkIndex >= state.totalChunks) {
      throw new Error(
        `chunkIndex ${chunkIndex} out of bounds for totalChunks ${state.totalChunks} (uploadId ${uploadId})`
      );
    }

    // Check for duplicate chunk
    if (state.chunks.has(chunkIndex)) {
      throw new Error(
        `Duplicate chunkIndex ${chunkIndex} for uploadId ${uploadId}`
      );
    }

    // Check per-upload byte limit before storing
    let currentBytes = 0;
    for (const chunk of state.chunks.values()) {
      currentBytes += chunk.length;
    }
    if (currentBytes + data.length > this.maxBytesPerUpload) {
      this.cleanup(uploadId);
      throw new Error(
        `Upload ${uploadId} exceeds max bytes per upload (${this.maxBytesPerUpload})`
      );
    }

    // Store chunk
    state.chunks.set(chunkIndex, data);

    // Check if all chunks received
    if (state.chunks.size === state.totalChunks) {
      // Assemble in correct order (0, 1, 2, ...)
      const orderedChunks: Buffer[] = [];
      for (let i = 0; i < state.totalChunks; i++) {
        const chunk = state.chunks.get(i);
        if (!chunk) {
          throw new Error(`Missing chunk ${i} for upload`);
        }
        orderedChunks.push(chunk);
      }
      const assembled = Buffer.concat(orderedChunks);

      // Clean up state
      this.cleanup(uploadId);

      return { complete: true, assembled };
    }

    return { complete: false };
  }

  /**
   * Check if an upload is complete (all chunks received).
   * Returns false if the uploadId is unknown (cleaned up or never started).
   */
  isComplete(uploadId: string): boolean {
    const state = this.uploads.get(uploadId);
    if (!state) return false;
    return state.chunks.size === state.totalChunks;
  }

  /**
   * Clean up state for a given uploadId, clearing the timeout timer.
   */
  cleanup(uploadId: string): void {
    const state = this.uploads.get(uploadId);
    if (state) {
      clearTimeout(state.timer);
      this.uploads.delete(uploadId);
    }
  }

  /**
   * Clean up all active uploads and their timers.
   * Call this on node shutdown to prevent timer leaks.
   */
  destroyAll(): void {
    for (const [, state] of this.uploads) {
      clearTimeout(state.timer);
    }
    this.uploads.clear();
  }
}
