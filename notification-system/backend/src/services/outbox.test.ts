import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock('../utils/database.js', () => ({ pool: { connect: vi.fn(async () => client) }, query: vi.fn() }));

import { relayOutboxBatch } from './outbox.js';

const row = (id: string, channel: string, priority: string) => ({
  id, channel, priority, payload: { notificationId: `n-${id}`, userId: 'u', channel, priority, queuedAt: 0 },
});

describe('relayOutboxBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return { rows: [row('1', 'sms', 'critical'), row('2', 'email', 'low'), row('3', 'push', 'normal')] };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it('publishes due rows to their channel/priority queue and marks them published', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await expect(relayOutboxBatch({ publish })).resolves.toEqual({ published: 3, failed: 0 });
    expect(publish.mock.calls.map((call) => call[0])).toEqual([
      'notifications.sms.critical', 'notifications.email.low', 'notifications.push.normal',
    ]);
    const select = client.query.mock.calls.find((call) => String(call[0]).startsWith('SELECT'))?.[0];
    expect(select).toContain('ORDER BY priority_rank, available_at');
    expect(select).toContain('FOR UPDATE SKIP LOCKED');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('SET published_at = NOW()'), [['1', '2', '3']]);
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('stops at the first unconfirmed publish and leaves the rest unpublished', async () => {
    const publish = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('publish confirm timed out'));
    await expect(relayOutboxBatch({ publish })).resolves.toEqual({ published: 1, failed: 1 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('publish_attempts = publish_attempts + 1'), ['2', 'publish confirm timed out']);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('SET published_at = NOW()'), [['1']]);
  });
});
