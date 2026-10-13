/**
 * Unit tests for the idempotent image job handler (services/mediaPipeline.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), getClient: vi.fn() }));
vi.mock('./storage.js', () => ({ processStoredImage: vi.fn(), deleteObject: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./redis.js', () => ({ invalidatePostCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./feedService.js', () => ({ fanOutPost: vi.fn() }));
vi.mock('./metrics.js', () => {
  const counter = { inc: vi.fn(), labels: vi.fn().mockReturnValue({ inc: vi.fn() }) };
  const histogram = { observe: vi.fn(), labels: vi.fn().mockReturnValue({ observe: vi.fn() }) };
  return { imageProcessingDuration: histogram, imageProcessingErrors: counter, imageJobOutcomes: counter };
});
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { query, getClient } from './db.js';
import { processStoredImage, deleteObject } from './storage.js';
import { invalidatePostCache } from './redis.js';
import { fanOutPost } from './feedService.js';
import { processImageJob, markPostFailed } from './mediaPipeline.js';

const POST_ID = 'ab111111-1111-1111-1111-111111111111';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const job = {
  postId: POST_ID,
  userId: USER_ID,
  mediaItems: [{ originalKey: 'originals/a.jpg', filterName: 'none', orderIndex: 0 }],
};
const delivery = { attempt: 1, maxAttempts: 3, redelivered: false };
const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length }) as never;

const mockClient = (lockedStatus: string | null) => {
  const client = {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return lockedStatus ? { rows: [{ status: lockedStatus, created_ms: '1000' }] } : { rows: [] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  vi.mocked(getClient).mockResolvedValue(client as never);
  return client;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockReset();
  vi.mocked(processStoredImage).mockResolvedValue({
    id: 'x',
    urls: {},
    width: 1080,
    height: 1080,
    filter: 'none',
    mediaUrl: 'http://minio/images/large.jpg',
    thumbnailUrl: 'http://minio/images/thumbnail.jpg',
  });
  vi.mocked(fanOutPost).mockResolvedValue({ mode: 'push', followerCount: 2, timelinesWritten: 3 });
});

describe('processImageJob', () => {
  it('skips a job whose post was deleted', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([]));

    await expect(processImageJob(job, delivery)).resolves.toBe('post_missing');

    expect(processStoredImage).not.toHaveBeenCalled();
    expect(fanOutPost).not.toHaveBeenCalled();
  });

  it('does no image work for a duplicate delivery but re-checks fan-out', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([{ status: 'published', created_ms: '1000' }]));

    await expect(processImageJob(job, delivery)).resolves.toBe('duplicate');

    expect(processStoredImage).not.toHaveBeenCalled();
    expect(fanOutPost).toHaveBeenCalledWith(USER_ID, POST_ID, 1000);
  });

  it('publishes: deterministic keys, one short transaction, then cleanup and fan-out', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([{ status: 'processing', created_ms: '1000' }]));
    const client = mockClient('processing');

    await expect(processImageJob(job, delivery)).resolves.toBe('published');

    expect(processStoredImage).toHaveBeenCalledWith('originals/a.jpg', 'none', `images/${POST_ID}/0`);
    const statements = client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 2).join(' '));
    expect(statements).toEqual(['BEGIN', 'SELECT status,', 'UPDATE post_media', 'UPDATE posts', 'COMMIT']);
    expect(deleteObject).toHaveBeenCalledWith('originals/a.jpg');
    expect(invalidatePostCache).toHaveBeenCalledWith(POST_ID);
    expect(fanOutPost).toHaveBeenCalledWith(USER_ID, POST_ID, 1000);
    expect(client.release).toHaveBeenCalled();
  });

  it('backs off when another delivery published the post first', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([{ status: 'processing', created_ms: '1000' }]));
    const client = mockClient('published');

    await expect(processImageJob(job, delivery)).resolves.toBe('duplicate');

    const statements = client.query.mock.calls.map(([sql]) => String(sql).trim());
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(fanOutPost).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('fails the job when fan-out fails after the commit, so the retry completes it', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([{ status: 'processing', created_ms: '1000' }]));
    const client = mockClient('processing');
    vi.mocked(fanOutPost).mockRejectedValueOnce(new Error('redis down'));

    await expect(processImageJob(job, delivery)).rejects.toThrow('redis down');

    expect(client.query.mock.calls.map(([sql]) => String(sql).trim())).toContain('COMMIT');
  });

  it('rolls back and rethrows when resizing fails, leaving the post processing', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([{ status: 'processing', created_ms: '1000' }]));
    vi.mocked(processStoredImage).mockRejectedValueOnce(new Error('unsupported image'));

    await expect(processImageJob(job, delivery)).rejects.toThrow('unsupported image');

    expect(getClient).not.toHaveBeenCalled();
  });
});

describe('markPostFailed', () => {
  it('only fails posts that are still processing and drops the cached copy', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([]));

    await markPostFailed(job, new Error('gave up'));

    expect(String(vi.mocked(query).mock.calls[0][0])).toContain("WHERE id = $1 AND status = 'processing'");
    expect(invalidatePostCache).toHaveBeenCalledWith(POST_ID);
  });
});
