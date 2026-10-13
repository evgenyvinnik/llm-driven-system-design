/**
 * Unit tests for the transactional outbox relay (services/outbox.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/index.js', () => ({ default: { mediaPipeline: { relayBatchSize: 50, relayIntervalMs: 2000 } } }));
vi.mock('./db.js', () => ({ query: vi.fn(), getClient: vi.fn() }));
vi.mock('./queue.js', () => ({
  publishImageProcessingJob: vi.fn(),
  isQueueReady: vi.fn(),
  ensureQueueConnection: vi.fn(),
}));
vi.mock('./metrics.js', () => ({
  outboxPendingEvents: { set: vi.fn() },
  outboxPublishedTotal: { inc: vi.fn() },
  outboxPublishFailures: { inc: vi.fn() },
}));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { query, getClient } from './db.js';
import { publishImageProcessingJob, isQueueReady, ensureQueueConnection } from './queue.js';
import { relayOutboxOnce, publishRetryDelayMs, OUTBOX_EVENT_TYPES } from './outbox.js';

const payload = (n: number) => ({ postId: `post-${n}`, userId: 'user-1', mediaItems: [] });
const event = (n: number, eventType: string = OUTBOX_EVENT_TYPES.POST_MEDIA_UPLOADED) => ({
  id: String(n),
  event_type: eventType,
  payload: payload(n),
  attempts: 0,
});

const mockClient = (claimed: unknown[]) => {
  const client = {
    query: vi.fn().mockImplementation(async (sql: string) => (sql.includes('FOR UPDATE SKIP LOCKED') ? { rows: claimed } : { rows: [] })),
    release: vi.fn(),
  };
  vi.mocked(getClient).mockResolvedValue(client as never);
  return client;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockResolvedValue({ rows: [{ pending: 0, oldest_age_seconds: null }] } as never);
});

describe('relayOutboxOnce', () => {
  it('claims nothing while the broker is down and starts a reconnect instead', async () => {
    vi.mocked(isQueueReady).mockReturnValue(false);
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ pending: 3, oldest_age_seconds: 42 }] } as never);

    const result = await relayOutboxOnce();

    expect(result).toEqual({ published: 0, failed: 0, skipped: true, pending: 3 });
    expect(ensureQueueConnection).toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it('publishes claimed events and stamps them published in the same transaction', async () => {
    vi.mocked(isQueueReady).mockReturnValue(true);
    vi.mocked(publishImageProcessingJob).mockResolvedValue(undefined);
    const client = mockClient([event(1), event(2)]);

    const result = await relayOutboxOnce();

    expect(result).toMatchObject({ published: 2, failed: 0, skipped: false });
    expect(publishImageProcessingJob).toHaveBeenNthCalledWith(1, payload(1));
    expect(publishImageProcessingJob).toHaveBeenNthCalledWith(2, payload(2));
    const statements = client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0]);
    expect(statements).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'UPDATE', 'COMMIT']);
    expect(client.query.mock.calls[2][1]).toEqual(['1']);
    expect(client.release).toHaveBeenCalled();
  });

  it('reschedules a failed publish with backoff and keeps going', async () => {
    vi.mocked(isQueueReady).mockReturnValue(true);
    vi.mocked(publishImageProcessingJob).mockRejectedValueOnce(new Error('nacked')).mockResolvedValueOnce(undefined);
    const client = mockClient([event(1), event(2)]);

    const result = await relayOutboxOnce();

    expect(result).toMatchObject({ published: 1, failed: 1 });
    const retry = client.query.mock.calls.find(([sql]) => String(sql).includes('next_attempt_at = NOW()'));
    expect(retry?.[1]).toEqual(['1', 'nacked', 1000]);
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim())).toContain('COMMIT');
  });

  it('treats an unknown event type as a failed publish rather than dropping it', async () => {
    vi.mocked(isQueueReady).mockReturnValue(true);
    mockClient([event(7, 'something.else')]);

    const result = await relayOutboxOnce();

    expect(result).toMatchObject({ published: 0, failed: 1 });
    expect(publishImageProcessingJob).not.toHaveBeenCalled();
  });
});

describe('publishRetryDelayMs', () => {
  it('doubles from one second and caps at a minute', () => {
    expect([1, 2, 3, 4].map(publishRetryDelayMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(publishRetryDelayMs(20)).toBe(60000);
  });
});
