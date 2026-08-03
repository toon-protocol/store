/**
 * End-to-end confirmation (issue #70 / toon-meta#262 decision 13) that kind:5094
 * carries an ENCRYPTED increment artifact through the real path unmodified:
 *
 *   buildBlobStorageRequest (core) -> POST /store (real startStoreBackend) ->
 *   real createArweaveDvmHandler (sdk) -> stub ArweaveUploadAdapter -> receipt
 *
 * Nothing here is mocked except the Turbo/Arweave network call itself (a stub
 * adapter that records what it was given) — the nostr event build/parse, HTTP
 * transport, signature verification, and chunk (re)assembly are all real. An
 * "encrypted artifact" is modeled as `crypto.randomBytes(n)`: uniformly random
 * bytes are not valid UTF-8/JSON, so any code on the path that assumed
 * readable/structured content would corrupt or reject it here.
 *
 * Retrieval (buyer fetches by txId against the ar.io-first gateway list) is
 * NOT store's concern — that lives in `@toon-protocol/arweave`
 * (toon-client `packages/arweave`, `ARWEAVE_GATEWAYS`), confirmed separately
 * and documented in README.md.
 */

import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import {
  createArweaveDvmHandler,
  ChunkManager,
  type ArweaveUploadAdapter,
} from '@toon-protocol/sdk';
import { startStoreBackend, type StoreHandler } from './store-backend.js';

/** Records every upload it receives instead of touching the network. */
function createRecordingAdapter(): ArweaveUploadAdapter & {
  uploads: { data: Buffer; tags?: Record<string, string>; txId: string }[];
} {
  const uploads: { data: Buffer; tags?: Record<string, string>; txId: string }[] = [];
  return {
    uploads,
    async upload(data, tags) {
      const txId = `stub-tx-${uploads.length + 1}-${data.length}`;
      uploads.push({ data: Buffer.from(data), tags, txId });
      return { txId };
    },
  };
}

async function withRealBackend(
  adapter: ArweaveUploadAdapter,
  run: (url: string) => Promise<void>
): Promise<void> {
  const handle = createArweaveDvmHandler({
    turboAdapter: adapter,
    chunkManager: new ChunkManager(),
  }) as unknown as StoreHandler;
  const backend = startStoreBackend({ handle, handlerPort: 0, devMode: false });
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

describe('kind:5094 carries an encrypted increment artifact end to end', () => {
  it('a small artifact (e.g. a plan) round-trips byte-for-byte with a real signature', async () => {
    const secretKey = generateSecretKey();
    const ciphertext = randomBytes(2_048); // opaque — not valid UTF-8/JSON
    const adapter = createRecordingAdapter();
    const event = buildBlobStorageRequest(
      { blobData: ciphertext, bid: '20480' }, // no contentType — encrypted blobs have none
      secretKey
    );

    await withRealBackend(adapter, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accept: boolean; txId?: string };
      expect(body.accept).toBe(true);
      // The receipt is returned UNCHANGED — the stub's txId, verbatim.
      expect(body.txId).toBe(adapter.uploads[0]?.txId);
    });

    expect(adapter.uploads).toHaveLength(1);
    // The bytes the uploader signed are EXACTLY the bytes handed to Arweave —
    // no re-encoding, no attempt to parse/interpret the ciphertext.
    expect(adapter.uploads[0]?.data.equals(ciphertext)).toBe(true);
    // No content-type declared -> sanitizes to the opaque-bytes default, never
    // a content-sniffed guess.
    expect(adapter.uploads[0]?.tags?.['Content-Type']).toBe('application/octet-stream');
  });

  it('a larger artifact (e.g. a built package or git-object pack) reassembles byte-for-byte across chunks', async () => {
    const secretKey = generateSecretKey();
    // ~1.2MB: bigger than a single ILP packet's ~500KB chunk threshold, so this
    // exercises real multi-chunk reassembly, not just the single-packet path.
    const ciphertext = randomBytes(1_234_567);
    const chunkSize = 500_000;
    const totalChunks = Math.ceil(ciphertext.length / chunkSize);
    const uploadId = '12345678-1234-4123-8123-123456789abc';
    const adapter = createRecordingAdapter();

    const events = Array.from({ length: totalChunks }, (_, i) => {
      const start = i * chunkSize;
      const chunk = ciphertext.subarray(start, Math.min(start + chunkSize, ciphertext.length));
      return buildBlobStorageRequest(
        {
          blobData: Buffer.from(chunk),
          bid: String(chunk.length),
          params: [
            { key: 'uploadId', value: uploadId },
            { key: 'chunkIndex', value: String(i) },
            { key: 'totalChunks', value: String(totalChunks) },
          ],
        },
        secretKey
      );
    });

    await withRealBackend(adapter, async (url) => {
      for (let i = 0; i < events.length; i++) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: events[i] }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { accept: boolean; txId?: string };
        expect(body.accept).toBe(true);
        if (i < events.length - 1) {
          // Intermediate chunks ack; no partial/garbled upload happens yet.
          expect(adapter.uploads).toHaveLength(0);
        } else {
          expect(adapter.uploads).toHaveLength(1);
          expect(body.txId).toBe(adapter.uploads[0]?.txId);
        }
      }
    });

    expect(adapter.uploads[0]?.data.equals(ciphertext)).toBe(true);
  });
});
