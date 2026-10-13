import { describe, it, expect, vi } from 'vitest';
import { ChunkedUploader, type UploadTransport } from './chunkedUploader';
import type { Video } from '../types';

const VIDEO_ID = '99999999-aaaa-4aaa-8aaa-999999999999';

/** In-memory storage that records part bodies by number and can be told to fail. */
function fakeTransport(options: { failPuts?: number; failStarts?: number; putDelayMs?: number } = {}) {
  const stored = new Map<number, string>();
  let failPuts = options.failPuts ?? 0;
  let failStarts = options.failStarts ?? 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const transport: UploadTransport = {
    start: vi.fn(async () => {
      if (failStarts-- > 0) throw new Error('network down');
      return { videoId: VIDEO_ID };
    }),
    partUrl: vi.fn(async (_videoId: string, partNumber: number) => `https://storage/part/${partNumber}`),
    putPart: vi.fn(async (url: string, body: Blob, onProgress: (loaded: number) => void) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (options.putDelayMs) await new Promise((resolve) => setTimeout(resolve, options.putDelayMs));
        if (failPuts-- > 0) throw new Error('connection reset');
        onProgress(body.size);
        stored.set(Number(url.split('/').pop()), await body.text());
      } finally {
        inFlight--;
      }
    }),
    complete: vi.fn(async (videoId: string) => ({ id: videoId, status: 'processing' }) as unknown as Video),
  };
  return { transport, stored, maxInFlight: () => maxInFlight };
}

const noSleep = async () => undefined;

function record(uploader: ChunkedUploader, chunks: string[]) {
  for (const chunk of chunks) uploader.push(new Blob([chunk]));
}

describe('ChunkedUploader', () => {
  it('cuts parts at the part size in recording order and completes with the part count', async () => {
    const { transport, stored } = fakeTransport();
    const uploader = new ChunkedUploader(transport, { partSize: 10, sleep: noSleep });
    record(uploader, ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'ee']);

    const video = await uploader.finish(42);

    // 12 bytes, 12 bytes, then a 2-byte tail: only the last part may be small.
    expect([...stored.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 'aaaaaabbbbbb'],
      [2, 'ccccccdddddd'],
      [3, 'ee'],
    ]);
    expect(transport.complete).toHaveBeenCalledWith(VIDEO_ID, 3, 42);
    expect(video.id).toBe(VIDEO_ID);
    expect(uploader.snapshot()).toMatchObject({ phase: 'done', uploadedBytes: 26, recordedBytes: 26 });
  });

  it('uploads parts while recording continues, so stopping leaves only the tail', async () => {
    const { transport } = fakeTransport();
    const uploader = new ChunkedUploader(transport, { partSize: 10, sleep: noSleep });
    record(uploader, ['0123456789', '0123456789']);
    await vi.waitFor(() => expect(uploader.snapshot().partsUploaded).toBe(2));
    expect(transport.complete).not.toHaveBeenCalled();
    uploader.push(new Blob(['tail']));
    await uploader.finish(5);
    expect(transport.putPart).toHaveBeenCalledTimes(3);
  });

  it('retries a failing part with a fresh URL each time', async () => {
    const { transport, stored } = fakeTransport({ failPuts: 2 });
    const uploader = new ChunkedUploader(transport, { partSize: 4, sleep: noSleep });
    record(uploader, ['abcd']);
    await uploader.finish(1);
    expect(stored.get(1)).toBe('abcd');
    expect(transport.partUrl).toHaveBeenCalledTimes(3);
  });

  it('pauses in error after the attempts run out and resumes with only the failed part', async () => {
    const { transport, stored } = fakeTransport({ failPuts: 3 });
    const uploader = new ChunkedUploader(transport, {
      partSize: 4,
      maxAttempts: 2,
      concurrency: 1,
      sleep: noSleep,
    });
    record(uploader, ['aaaa']);
    await expect(uploader.finish(1)).rejects.toThrow('connection reset');
    expect(uploader.snapshot()).toMatchObject({ phase: 'error', partsUploaded: 0 });

    const resumed = uploader.retry();
    expect(resumed).not.toBeNull();
    await resumed;
    expect(stored.get(1)).toBe('aaaa');
    expect(uploader.snapshot().phase).toBe('done');
  });

  it('keeps parts queued until the upload session can be opened', async () => {
    const { transport } = fakeTransport({ failStarts: 2 });
    const uploader = new ChunkedUploader(transport, { partSize: 4, sleep: noSleep });
    uploader.begin();
    record(uploader, ['abcd', 'efgh']);
    await uploader.finish(2);
    expect(transport.start).toHaveBeenCalledTimes(3);
    expect(transport.complete).toHaveBeenCalledWith(VIDEO_ID, 2, 2);
  });

  it('never has more parts in flight than the concurrency limit', async () => {
    const fake = fakeTransport({ putDelayMs: 5 });
    const uploader = new ChunkedUploader(fake.transport, { partSize: 2, concurrency: 2, sleep: noSleep });
    record(uploader, ['aa', 'bb', 'cc', 'dd', 'ee', 'ff']);
    await uploader.finish(3);
    expect(fake.maxInFlight()).toBe(2);
  });

  it('stops uploading after abort and reports the video to delete', async () => {
    const { transport } = fakeTransport({ putDelayMs: 5 });
    const uploader = new ChunkedUploader(transport, { partSize: 2, concurrency: 1, sleep: noSleep });
    uploader.begin();
    record(uploader, ['aa', 'bb', 'cc']);
    expect(await uploader.abort()).toBe(VIDEO_ID);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(vi.mocked(transport.putPart).mock.calls.length).toBeLessThan(3);
    expect(transport.complete).not.toHaveBeenCalled();
  });

  it('refuses to finish an empty recording', async () => {
    const { transport } = fakeTransport();
    const uploader = new ChunkedUploader(transport, { sleep: noSleep });
    await expect(uploader.finish(0)).rejects.toThrow('Nothing was recorded');
  });
});
