import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('./storageService.js', () => ({
  startMultipartUpload: vi.fn(),
  getPresignedPartUrl: vi.fn(),
  listUploadedParts: vi.fn(),
  completeMultipartUpload: vi.fn(),
  abortMultipartUpload: vi.fn(),
  getObjectStat: vi.fn(),
  isNotFoundError: (err: { code?: string }) =>
    err?.code === 'NoSuchKey' || err?.code === 'NotFound' || err?.code === 'NoSuchUpload',
}));
vi.mock('./jobQueue.js', () => ({ enqueueJob: vi.fn() }));

import { pool } from './db.js';
import * as storage from './storageService.js';
import { enqueueJob } from './jobQueue.js';
import {
  startUpload,
  presignPart,
  completeUpload,
  findPartProblems,
  sweepStaleUploads,
  UploadError,
} from './uploadService.js';

const query = pool.query as unknown as ReturnType<typeof vi.fn>;
const connect = pool.connect as unknown as ReturnType<typeof vi.fn>;
const mocked = vi.mocked(storage);

const USER = 'a1111111-1111-1111-1111-111111111111';
const VIDEO = '99999999-aaaa-4aaa-8aaa-999999999999';
const KEY = `${USER}/${VIDEO}/source.webm`;
const MIB = 1024 * 1024;

function uploadingRow(extra: Record<string, unknown> = {}) {
  return { id: VIDEO, user_id: USER, status: 'uploading', storage_path: KEY, upload_id: 'up-1', ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findPartProblems', () => {
  const part = (n: number, size = 5 * MIB) => ({ part: n, size });

  it('accepts contiguous parts with a short final part', () => {
    expect(findPartProblems([part(1), part(2), part(3, 1000)], 3, 5 * MIB)).toBeNull();
  });

  it('names the missing parts', () => {
    expect(findPartProblems([part(1), part(3, 10)], 3, 5 * MIB)).toEqual({
      reason: 'Upload incomplete',
      missingParts: [2],
    });
  });

  it('rejects a non-final part below the multipart minimum', () => {
    expect(findPartProblems([part(1, 1000), part(2, 10)], 2, 5 * MIB)?.reason).toMatch(/minimum size: 1/);
  });

  it('rejects parts beyond the declared count', () => {
    expect(findPartProblems([part(1), part(2)], 1, 5 * MIB)?.reason).toMatch(/beyond partCount/);
  });
});

describe('startUpload', () => {
  it('returns the open upload instead of starting a second one', async () => {
    query.mockResolvedValueOnce({ rows: [uploadingRow()] });
    const result = await startUpload(VIDEO, USER);
    expect(result).toMatchObject({ uploadId: 'up-1', objectName: KEY, created: false });
    expect(mocked.startMultipartUpload).not.toHaveBeenCalled();
  });

  it('aborts its own multipart upload when a concurrent start won the row', async () => {
    query
      .mockResolvedValueOnce({ rows: [uploadingRow({ upload_id: null, storage_path: null })] })
      .mockResolvedValueOnce({ rows: [] }) // conditional UPDATE lost the race
      .mockResolvedValueOnce({ rows: [uploadingRow({ upload_id: 'winner' })] });
    mocked.startMultipartUpload.mockResolvedValueOnce('loser');
    mocked.abortMultipartUpload.mockResolvedValueOnce();

    const result = await startUpload(VIDEO, USER);
    expect(mocked.abortMultipartUpload).toHaveBeenCalledWith(KEY, 'loser');
    expect(result).toMatchObject({ uploadId: 'winner', created: false });
  });

  it('refuses videos that are no longer uploading', async () => {
    query.mockResolvedValueOnce({ rows: [uploadingRow({ status: 'ready' })] });
    await expect(startUpload(VIDEO, USER)).rejects.toMatchObject({ status: 409 });
  });
});

describe('presignPart', () => {
  it('validates the part number range', async () => {
    await expect(presignPart(VIDEO, USER, 0)).rejects.toBeInstanceOf(UploadError);
    await expect(presignPart(VIDEO, USER, 10001)).rejects.toMatchObject({ status: 400 });
    await expect(presignPart(VIDEO, USER, '2')).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it('bumps upload activity and presigns against the stored upload', async () => {
    query.mockResolvedValueOnce({ rows: [{ storage_path: KEY, upload_id: 'up-1' }] });
    mocked.getPresignedPartUrl.mockResolvedValueOnce('https://storage/part?partNumber=4');
    const result = await presignPart(VIDEO, USER, 4);
    expect(query.mock.calls[0][0]).toContain('upload_activity_at = NOW()');
    expect(mocked.getPresignedPartUrl).toHaveBeenCalledWith(KEY, 'up-1', 4);
    expect(result.url).toContain('partNumber=4');
  });
});

describe('completeUpload', () => {
  function transactionClient(updateRows: unknown[]) {
    const client = {
      query: vi.fn(async (sql: string) => (sql.startsWith('UPDATE videos') ? { rows: updateRows } : { rows: [] })),
      release: vi.fn(),
    };
    connect.mockResolvedValueOnce(client);
    return client;
  }

  it('is a no-op replay once the video left uploading', async () => {
    query.mockResolvedValueOnce({ rows: [uploadingRow({ status: 'processing' })] });
    const result = await completeUpload(VIDEO, USER, { partCount: 2 });
    expect(result.replayed).toBe(true);
    expect(mocked.listUploadedParts).not.toHaveBeenCalled();
  });

  it('refuses to stitch when storage is missing a part the client declared', async () => {
    query.mockResolvedValueOnce({ rows: [uploadingRow()] });
    mocked.listUploadedParts.mockResolvedValueOnce([{ part: 1, etag: 'a', size: 5 * MIB }]);
    await expect(completeUpload(VIDEO, USER, { partCount: 2 })).rejects.toMatchObject({
      status: 409,
      details: { missingParts: [2] },
    });
    expect(mocked.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('stitches with the ETags storage reports, then flips status and enqueues in one transaction', async () => {
    query.mockResolvedValueOnce({ rows: [uploadingRow()] });
    mocked.listUploadedParts.mockResolvedValueOnce([
      { part: 1, etag: 'etag-1', size: 5 * MIB },
      { part: 2, etag: 'etag-2', size: 1234 },
    ]);
    mocked.getObjectStat.mockResolvedValueOnce({ size: 5 * MIB + 1234 } as never);
    const client = transactionClient([{ id: VIDEO, status: 'processing' }]);

    const result = await completeUpload(VIDEO, USER, { partCount: 2, durationSeconds: 61.6 });

    expect(mocked.completeMultipartUpload).toHaveBeenCalledWith(KEY, 'up-1', [
      { part: 1, etag: 'etag-1' },
      { part: 2, etag: 'etag-2' },
    ]);
    const statements = client.query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/)[0]);
    expect(statements).toEqual(['BEGIN', 'UPDATE', 'COMMIT']);
    expect(client.query.mock.calls[1][1]).toEqual([VIDEO, 5 * MIB + 1234, 62]);
    expect(enqueueJob).toHaveBeenCalledWith(client, VIDEO, 'process_upload');
    expect(result.replayed).toBe(false);
  });

  it('treats a concurrently completed upload as a replay, not an error', async () => {
    query
      .mockResolvedValueOnce({ rows: [uploadingRow()] })
      .mockResolvedValueOnce({ rows: [uploadingRow({ status: 'processing' })] });
    mocked.listUploadedParts.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'NoSuchUpload' }));
    mocked.getObjectStat.mockResolvedValueOnce({ size: 10 } as never);
    const client = transactionClient([]);

    const result = await completeUpload(VIDEO, USER, {});
    expect(result.replayed).toBe(true);
    expect(client.query.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('never marks a video playable when the object is not in storage', async () => {
    query.mockResolvedValueOnce({ rows: [uploadingRow()] });
    mocked.listUploadedParts.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'NoSuchUpload' }));
    mocked.getObjectStat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'NotFound' }));
    await expect(completeUpload(VIDEO, USER, {})).rejects.toMatchObject({ status: 409 });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('sweepStaleUploads', () => {
  it('claims stale rows in one statement and aborts their multipart uploads', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: 'v1', upload_id: 'u1', storage_path: 'k1' },
        { id: 'v2', upload_id: null, storage_path: null },
        { id: 'v3', upload_id: 'u3', storage_path: 'k3' },
      ],
    });
    mocked.abortMultipartUpload.mockResolvedValueOnce().mockRejectedValueOnce(new Error('storage down'));

    const result = await sweepStaleUploads(30, 10);

    expect(query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(query.mock.calls[0][1]).toEqual([30, 10]);
    expect(mocked.abortMultipartUpload).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ swept: 3, aborted: 1 });
  });
});
