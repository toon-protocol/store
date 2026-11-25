import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { createArweaveDvmHandler } from './arweave-dvm-handler.js';
import { ChunkManager } from './chunk-manager.js';
import type { ArweaveUploadAdapter } from './turbo-adapter.js';
import type { StoreHandlerContext } from './store-backend.js';

function ctxFor(event: unknown): StoreHandlerContext {
  return {
    toon: '',
    kind: 5094,
    pubkey: 'p',
    amount: 0n,
    destination: 'g.test',
    decode: () => event as ReturnType<StoreHandlerContext['decode']>,
    accept: (metadata) => ({ accept: true, ...(metadata ? { metadata } : {}) }),
    reject: (code, message) => ({ accept: false, code, message }),
  };
}

function setup(upload?: ArweaveUploadAdapter['upload']) {
  const adapter = {
    upload: vi.fn(upload ?? (async () => ({ txId: 'tx-1' }))),
  };
  const handler = createArweaveDvmHandler({
    turboAdapter: adapter,
    chunkManager: new ChunkManager(),
    arweaveTags: { App: 'toon' },
  });
  return { adapter, handler };
}

function chunked(d: string, uploadId: string, i: number) {
  return {
    blobData: Buffer.from(d),
    bid: String(d.length),
    params: [
      { key: 'uploadId', value: uploadId },
      { key: 'chunkIndex', value: String(i) },
      { key: 'totalChunks', value: '2' },
    ],
  };
}

function uploadArgs(adapter: { upload: { mock: { calls: unknown[][] } } }) {
  return (adapter.upload.mock.calls[0] ?? []) as [Buffer, Record<string, string>];
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('createArweaveDvmHandler', () => {
  it('uploads a single-packet blob and returns base64(txId)', async () => {
    const { adapter, handler } = setup();
    const event = buildBlobStorageRequest({ blobData: Buffer.from('hello'), bid: '5' }, generateSecretKey());
    const res = await handler(ctxFor(event));
    expect(res).toEqual({ accept: true, data: b64('tx-1') });
    expect(adapter.upload).toHaveBeenCalledTimes(1);
    const [data, tags] = uploadArgs(adapter);
    expect(data.toString()).toBe('hello');
    expect(tags).toMatchObject({ App: 'toon' });
  });

  it('rejects a malformed request with F00', async () => {
    const { handler } = setup();
    const res = await handler(ctxFor({ kind: 5094, tags: [], content: '' }));
    expect(res).toMatchObject({ accept: false, code: 'F00' });
  });

  it('answers T00 without leaking the cause when the upload fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = setup(async () => {
      throw new Error('secret rpc url');
    });
    const event = buildBlobStorageRequest({ blobData: Buffer.from('x'), bid: '1' }, generateSecretKey());
    const res = await handler(ctxFor(event));
    expect(res).toEqual({ accept: false, code: 'T00', message: 'Arweave upload failed' });
    spy.mockRestore();
  });

  it('acks intermediate chunks and uploads the assembled blob on the last', async () => {
    const { adapter, handler } = setup();
    const sk = generateSecretKey();
    const mk = (i: number, d: string) =>
      buildBlobStorageRequest(
        chunked(d, '11111111-1111-4111-8111-111111111111', i),
        sk
      );
    expect(await handler(ctxFor(mk(0, 'ab')))).toEqual({ accept: true, data: b64('ack:0') });
    expect(adapter.upload).not.toHaveBeenCalled();
    expect(await handler(ctxFor(mk(1, 'cd')))).toEqual({ accept: true, data: b64('tx-1') });
    expect(uploadArgs(adapter)[0].toString()).toBe('abcd');
  });

  it('maps a duplicate chunk to a safe message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = setup();
    const sk = generateSecretKey();
    const ev = buildBlobStorageRequest(
      chunked('a', '22222222-2222-4222-8222-222222222222', 0),
      sk
    );
    await handler(ctxFor(ev));
    const res = await handler(ctxFor(ev));
    expect(res).toEqual({ accept: false, code: 'F00', message: 'Duplicate chunk rejected' });
    spy.mockRestore();
  });

  it('sanitizes a hostile content type', async () => {
    const { adapter, handler } = setup();
    const event = buildBlobStorageRequest(
      { blobData: Buffer.from('x'), bid: '1', contentType: 'text/html\r\nX-Evil: 1' },
      generateSecretKey()
    );
    await handler(ctxFor(event));
    expect(uploadArgs(adapter)[1]).toMatchObject({
      'Content-Type': 'application/octet-stream',
    });
  });
});
