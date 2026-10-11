import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile } from 'fs/promises';

vi.mock('../services/db.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../services/storageService.js', () => ({ downloadToFile: vi.fn(), uploadFromFile: vi.fn() }));

import { pool } from '../services/db.js';
import { backoffSeconds, failJob, type Job } from '../services/jobQueue.js';
import { processUploadJob, renditionKeys, type ProcessorDeps } from './videoProcessor.js';

const query = pool.query as unknown as ReturnType<typeof vi.fn>;
const connect = pool.connect as unknown as ReturnType<typeof vi.fn>;

const VIDEO = '99999999-aaaa-4aaa-8aaa-999999999999';
const SOURCE = `a1111111-1111-1111-1111-111111111111/${VIDEO}/source.webm`;
const job: Job = { id: '7', video_id: VIDEO, kind: 'process_upload', status: 'running', attempts: 2, locked_by: 'w1' };

function fakeDeps(overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    tools: {
      remux: vi.fn(async (_input: string, output: string) => writeFile(output, 'remuxed')),
      probeDurationSeconds: vi.fn(async () => 12.4),
      hasVideoStream: vi.fn(async () => true),
      extractThumbnail: vi.fn(async (_input: string, output: string) => writeFile(output, 'jpeg')),
    },
    download: vi.fn(async (_key: string, file: string) => writeFile(file, 'source')),
    upload: vi.fn(async () => undefined),
    fileSize: vi.fn(async () => 4321),
    ...overrides,
  };
}

function transactionClient(jobDoneRowCount: number) {
  const client = {
    query: vi.fn(async (sql: string) =>
      sql.includes('UPDATE video_jobs') ? { rowCount: jobDoneRowCount, rows: [] } : { rowCount: 1, rows: [] },
    ),
    release: vi.fn(),
  };
  connect.mockResolvedValueOnce(client);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('renditionKeys', () => {
  it('writes fixed keys next to the source so retries overwrite instead of duplicating', () => {
    expect(renditionKeys(SOURCE)).toEqual({
      playback: SOURCE.replace('source.webm', 'playback.webm'),
      thumbnail: SOURCE.replace('source.webm', 'thumb.jpg'),
    });
  });
});

describe('processUploadJob', () => {
  it('remuxes, probes, thumbnails, uploads, then commits under the lease', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: VIDEO, status: 'processing', source_path: SOURCE }] });
    const client = transactionClient(1);
    const deps = fakeDeps();

    expect(await processUploadJob(job, 'w1', deps)).toBe('done');

    const keys = renditionKeys(SOURCE);
    expect(deps.upload).toHaveBeenCalledWith(keys.thumbnail, expect.any(String), 'image/jpeg');
    expect(deps.upload).toHaveBeenCalledWith(keys.playback, expect.any(String), 'video/webm');
    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('UPDATE video_jobs');
    expect(client.query.mock.calls[1][1]).toEqual(['7', 'w1', 2]);
    expect(sql[2]).toContain("SET status = 'ready'");
    expect(client.query.mock.calls[2][1]).toEqual([VIDEO, keys.playback, keys.thumbnail, 12, 4321]);
    expect(sql[3]).toBe('COMMIT');
  });

  it('writes nothing to the video when the lease was lost to another worker', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: VIDEO, status: 'processing', source_path: SOURCE }] });
    const client = transactionClient(0);

    expect(await processUploadJob(job, 'w1', fakeDeps())).toBe('lost');
    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql).toContain('ROLLBACK');
    expect(sql.some((s) => s.includes('UPDATE videos'))).toBe(false);
  });

  it('skips audio-only recordings for thumbnails but still serves the remux', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: VIDEO, status: 'processing', source_path: SOURCE }] });
    const client = transactionClient(1);
    const deps = fakeDeps();
    vi.mocked(deps.tools.hasVideoStream).mockResolvedValueOnce(false);

    expect(await processUploadJob(job, 'w1', deps)).toBe('done');
    expect(deps.tools.extractThumbnail).not.toHaveBeenCalled();
    expect(client.query.mock.calls[2][1]?.[2]).toBeNull();
  });

  it('closes the job without work when the video was deleted', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const deps = fakeDeps();
    expect(await processUploadJob(job, 'w1', deps)).toBe('skipped');
    expect(deps.download).not.toHaveBeenCalled();
  });
});

describe('job retries', () => {
  it('backs off exponentially and caps at ten minutes', () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([10, 20, 40, 80]);
    expect(backoffSeconds(20)).toBe(600);
  });

  it('requeues until attempts run out, then dead-letters', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });
    expect(await failJob({ ...job, attempts: 2 }, 'w1', new Error('ffmpeg exited 1'), 5)).toBe('retry');
    expect(query.mock.calls[0][1]?.[3]).toBe('queued');
    expect(await failJob({ ...job, attempts: 5 }, 'w1', new Error('ffmpeg exited 1'), 5)).toBe('dead');
    expect(query.mock.calls[1][1]?.[3]).toBe('dead');
  });

  it('reports a lost lease instead of overwriting the new owner', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await failJob(job, 'w1', new Error('late'), 5)).toBe('lost');
  });
});
