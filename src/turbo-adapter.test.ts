import { describe, it, expect, vi } from 'vitest';
import { TurboUploadAdapter } from './turbo-adapter.js';

async function drain(stream: AsyncIterable<Buffer>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(Buffer.from(p));
  return Buffer.concat(parts).toString();
}

describe('TurboUploadAdapter', () => {
  it('streams the data to the client with tags and returns the id', async () => {
    const uploadFile = vi.fn(async (p: { fileStreamFactory: () => AsyncIterable<Buffer> }) => {
      expect(await drain(p.fileStreamFactory())).toBe('hello');
      return { id: 'abc' };
    });
    const adapter = new TurboUploadAdapter({ uploadFile });
    const res = await adapter.upload(Buffer.from('hello'), { 'Content-Type': 'text/plain' });
    expect(res).toEqual({ txId: 'abc' });
    const arg = (uploadFile.mock.calls[0]?.[0] as unknown as {
      fileSizeFactory(): number;
      dataItemOpts: unknown;
    });
    expect(arg.fileSizeFactory()).toBe(5);
    expect(arg.dataItemOpts).toEqual({ tags: [{ name: 'Content-Type', value: 'text/plain' }] });
  });

  it('omits dataItemOpts when there are no tags', async () => {
    const uploadFile = vi.fn(async () => ({ id: 'x' }));
    await new TurboUploadAdapter({ uploadFile }).upload(Buffer.from('a'));
    expect(uploadFile.mock.calls[0]?.[0]).not.toHaveProperty('dataItemOpts');
  });
});
