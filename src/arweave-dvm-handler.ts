/**
 * Arweave DVM handler for kind:5094 blob storage requests.
 *
 * Creates a handler function that:
 * 1. Parses the kind:5094 event from the StoreHandlerContext
 * 2. For single-packet uploads: uploads directly to Arweave via the adapter
 * 3. For chunked uploads: accumulates via ChunkManager, uploads on completion
 *
 * The handler does NOT validate pricing -- the connector terminates payment
 * BEFORE the request reaches this backend.
 *
 * Returns HandlePacketAcceptResponse with `data` field containing the Arweave
 * tx ID -- NOT via ctx.accept() which only supports metadata.
 */

import { parseBlobStorageRequest } from '@toon-protocol/core';
import type { StoreHandlerContext, StoreHandlerResponse } from './store-backend.js';
import type { ArweaveUploadAdapter } from './turbo-adapter.js';
import type { ChunkManager } from './chunk-manager.js';

/**
 * Validates and sanitizes a MIME content type string.
 * Returns sanitized type or 'application/octet-stream' for invalid values.
 *
 * Defends against header injection (CWE-113) and ensures only well-formed
 * MIME types are forwarded to the Arweave upload adapter.
 */
const MIME_REGEX =
  /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/;
function sanitizeContentType(contentType: string): string {
  // Strip any parameters (e.g., "; charset=utf-8") and whitespace
  const base = (contentType.split(';')[0] ?? '').trim();
  if (base.length > 0 && base.length <= 255 && MIME_REGEX.test(base)) {
    return base;
  }
  return 'application/octet-stream';
}

export interface ArweaveDvmConfig {
  /** Arweave upload adapter (wraps @ardrive/turbo-sdk). */
  turboAdapter: ArweaveUploadAdapter;
  /** Chunk state manager for multi-packet uploads. */
  chunkManager: ChunkManager;
  /** Optional default Arweave data item tags (e.g., Content-Type). */
  arweaveTags?: Record<string, string>;
}

/**
 * Creates an Arweave DVM handler for kind:5094 blob storage requests.
 *
 * @param config - Handler configuration with adapter and chunk manager.
 * @returns A handler function taking the store's own handler context.
 */
export function createArweaveDvmHandler(
  config: ArweaveDvmConfig
): (ctx: StoreHandlerContext) => Promise<StoreHandlerResponse> {
  const { turboAdapter, chunkManager, arweaveTags } = config;

  return async (ctx: StoreHandlerContext): Promise<StoreHandlerResponse> => {
    // Decode the TOON payload into a full NostrEvent
    const event = ctx.decode();

    // Parse the kind:5094 event
    const parsed = parseBlobStorageRequest(event);
    if (!parsed) {
      return {
        accept: false,
        code: 'F00',
        message: 'Malformed kind:5094 blob storage request',
      };
    }

    // Build tags for Arweave upload.
    // Event-level Content-Type takes precedence over config-level arweaveTags.
    // Sanitize to prevent header injection (CWE-113) from user-controlled input.
    const uploadTags: Record<string, string> = {
      ...arweaveTags,
      'Content-Type': sanitizeContentType(parsed.contentType),
    };

    // Check if this is a chunked upload
    if (
      parsed.uploadId !== undefined &&
      parsed.chunkIndex !== undefined &&
      parsed.totalChunks !== undefined
    ) {
      try {
        const result = chunkManager.addChunk(
          parsed.uploadId,
          parsed.chunkIndex,
          parsed.totalChunks,
          parsed.blobData
        );

        if (!result.complete) {
          // Intermediate chunk -- acknowledge receipt
          return {
            accept: true,
            data: Buffer.from(`ack:${parsed.chunkIndex}`).toString('base64'),
          };
        }

        // All chunks received -- upload assembled blob
        // assembled is guaranteed to be present when complete is true
        const assembled = result.assembled ?? Buffer.alloc(0);
        const { txId } = await turboAdapter.upload(assembled, uploadTags);

        // Base64-encode txId for ILP FULFILL data field (connector validates base64)
        return {
          accept: true,
          data: Buffer.from(txId).toString('base64'),
        };
      } catch (error) {
        // Log full error internally but return generic message to client (CWE-209)
        console.error(
          '[ArweaveDvmHandler] Chunked upload failed:',
          error instanceof Error ? (error.stack ?? error.message) : error
        );
        const internalMsg =
          error instanceof Error ? error.message : 'Unknown chunk error';
        // Only surface safe, expected error categories to callers
        const safeMsg = internalMsg.includes('Duplicate chunkIndex')
          ? 'Duplicate chunk rejected'
          : internalMsg.includes('Max active uploads')
            ? 'Server busy, too many concurrent uploads'
            : internalMsg.includes('exceeds max bytes')
              ? 'Upload size limit exceeded'
              : 'Chunk processing error';
        return {
          accept: false,
          code: 'F00',
          message: safeMsg,
        };
      }
    }

    // Single-packet upload
    try {
      const { txId } = await turboAdapter.upload(parsed.blobData, uploadTags);
      // Base64-encode txId for ILP FULFILL data field (connector validates base64)
      return {
        accept: true,
        data: Buffer.from(txId).toString('base64'),
      };
    } catch (error) {
      // Log the full underlying error server-side for operator/gate diagnostics
      // (e.g. Turbo upload-service rejection, network timeout to upload.ardrive.io,
      // a >100 KB payload exceeding the unauthenticated free-tier limit, or a
      // throwing/no-credential adapter — see #146). The stub adapter used to
      // swallow the cause as a bare "Arweave upload failed"; we now always emit
      // the real reason here so the failure self-diagnoses from the dvm logs.
      // The client still only receives a generic message (CWE-209): we never
      // forward SDK internals over the wire.
      const cause =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(
        `[ArweaveDvmHandler] Arweave upload failed (${parsed.blobData.length} bytes). ` +
          `Cause: ${cause}`
      );
      return {
        accept: false,
        code: 'T00',
        message: 'Arweave upload failed',
      };
    }
  };
}
