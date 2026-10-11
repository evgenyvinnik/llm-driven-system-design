import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';

vi.mock('../utils/database.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../utils/queue.js', () => ({
  isQueueConnected: vi.fn(),
  publishClickEvent: vi.fn(),
}));

import { withTransaction } from '../utils/database.js';
import { isQueueConnected, publishClickEvent } from '../utils/queue.js';
import {
  recordClickEvent,
  dispatchClickEvent,
  waitForPendingClickDispatches,
} from './analyticsService.js';
import type { ClickEventMessage } from '../models/types.js';

const event: ClickEventMessage = {
  event_id: '3f1c9a52-6b7e-4d43-9a3e-2f5b8c1d0e47',
  short_code: 'abc123x',
  referrer: 'https://news.ycombinator.com',
  user_agent: 'Mozilla/5.0',
  ip_address: '203.0.113.7',
  device_type: 'desktop',
  timestamp: '2026-10-10T12:00:00.000Z',
};

/**
 * Runs withTransaction callbacks against a client whose INSERT reports `insertedRows`.
 */
function fakeTransaction(insertedRows: number) {
  const client = {
    query: vi.fn(async (sql: string) =>
      sql.includes('INSERT INTO click_events') ? { rowCount: insertedRows, rows: [] } : { rowCount: 1, rows: [] }
    ),
  };
  vi.mocked(withTransaction).mockImplementation(async (callback) => callback(client as unknown as PoolClient));
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordClickEvent (worker idempotency decision)', () => {
  it('inserts the event keyed by event_id and increments the counter in the same transaction', async () => {
    const client = fakeTransaction(1);

    expect(await recordClickEvent(event)).toBe(true);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    const [insertSql, insertParams] = client.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(insertSql).toContain('ON CONFLICT (event_id) DO NOTHING');
    expect(insertParams[0]).toBe(event.event_id);
    const [updateSql, updateParams] = client.query.mock.calls[1] as unknown as [string, unknown[]];
    expect(updateSql).toContain('click_count = click_count + 1');
    expect(updateParams).toEqual(['abc123x']);
  });

  it('does not touch the counter when the event was already recorded (redelivery)', async () => {
    const client = fakeTransaction(0);

    expect(await recordClickEvent(event)).toBe(false);

    expect(client.query).toHaveBeenCalledTimes(1); // INSERT only, no UPDATE
  });

  it('propagates database errors so the consumer can retry', async () => {
    vi.mocked(withTransaction).mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    await expect(recordClickEvent(event)).rejects.toThrow('down');
  });
});

describe('dispatchClickEvent', () => {
  it('publishes to the queue and skips the direct insert when the broker confirms', async () => {
    vi.mocked(isQueueConnected).mockReturnValue(true);
    vi.mocked(publishClickEvent).mockResolvedValue(true);

    dispatchClickEvent(event);
    await waitForPendingClickDispatches(1000);

    expect(publishClickEvent).toHaveBeenCalledWith(event);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('falls back to the direct insert when the publish is not confirmed', async () => {
    vi.mocked(isQueueConnected).mockReturnValue(true);
    vi.mocked(publishClickEvent).mockResolvedValue(false);
    fakeTransaction(1);

    dispatchClickEvent(event);
    await waitForPendingClickDispatches(1000);

    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('records directly without publishing while the queue is down', async () => {
    vi.mocked(isQueueConnected).mockReturnValue(false);
    fakeTransaction(1);

    dispatchClickEvent(event);
    await waitForPendingClickDispatches(1000);

    expect(publishClickEvent).not.toHaveBeenCalled();
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('never throws to the caller when both paths fail', async () => {
    vi.mocked(isQueueConnected).mockReturnValue(false);
    vi.mocked(withTransaction).mockRejectedValue(new Error('database down'));

    expect(() => dispatchClickEvent(event)).not.toThrow();
    await expect(waitForPendingClickDispatches(1000)).resolves.toBeUndefined();
  });
});
