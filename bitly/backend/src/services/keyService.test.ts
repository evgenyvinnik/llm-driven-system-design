import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PoolClient } from 'pg';

vi.mock('../utils/database.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

const MINUTE = 60 * 1000;

/**
 * Loads a fresh copy of keyService (its local key cache is module state) whose batch
 * fetches return the given batches in order (the last one repeats).
 */
async function loadKeyService(batches: Array<string[] | Promise<string[]>>) {
  vi.resetModules();
  const db = await import('../utils/database.js');
  // Mocked modules survive resetModules, so clear their call history explicitly.
  vi.mocked(db.query).mockReset();
  const withTransaction = vi.mocked(db.withTransaction);
  withTransaction.mockReset();
  let call = 0;
  withTransaction.mockImplementation(async (callback) => {
    const codes = await batches[Math.min(call++, batches.length - 1)];
    const client = {
      query: vi.fn().mockResolvedValue({ rows: codes.map((short_code) => ({ short_code })) }),
    } as unknown as PoolClient;
    return callback(client);
  });
  const service = await import('./keyService.js');
  return { service, withTransaction, query: vi.mocked(db.query) };
}

const codes = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);

describe('isLeaseUsable', () => {
  it('keeps keys until the safety margin before the lease TTL', async () => {
    const { service } = await loadKeyService([[]]);
    const leasedAt = 1_000_000;
    // defaults: 60 min lease, 10 min margin => usable for 50 minutes
    expect(service.isLeaseUsable(leasedAt, leasedAt + 49 * MINUTE)).toBe(true);
    expect(service.isLeaseUsable(leasedAt, leasedAt + 50 * MINUTE)).toBe(false);
    expect(service.isLeaseUsable(leasedAt, leasedAt + 2 * 60 * MINUTE)).toBe(false);
  });

  it('honors explicit TTL and margin', async () => {
    const { service } = await loadKeyService([[]]);
    expect(service.isLeaseUsable(0, 4_999, 10_000, 5_000)).toBe(true);
    expect(service.isLeaseUsable(0, 5_000, 10_000, 5_000)).toBe(false);
  });
});

describe('getNextKey', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands out the oldest leased key first', async () => {
    const { service } = await loadKeyService([codes('a', 100)]);
    expect(await service.getNextKey()).toBe('a000');
    expect(await service.getNextKey()).toBe('a001');
  });

  it('discards local keys whose lease is about to expire and leases a fresh batch', async () => {
    const { service, withTransaction } = await loadKeyService([codes('old', 100), codes('new', 100)]);
    expect(await service.getNextKey()).toBe('old000');
    expect(service.getLocalCacheCount()).toBe(99);

    vi.setSystemTime(new Date('2026-10-10T12:51:00Z')); // 51 minutes later
    expect(await service.getNextKey()).toBe('new000');
    expect(withTransaction).toHaveBeenCalledTimes(2);
    expect(service.getLocalCacheCount()).toBe(99); // only the fresh batch remains
  });

  it('coalesces concurrent refills into one lease query', async () => {
    const { service, withTransaction } = await loadKeyService([codes('k', 3)]);
    const [first, second] = await Promise.all([service.getNextKey(), service.getNextKey()]);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(new Set([first, second]).size).toBe(2);
  });

  it('refills in the background while keys remain below the threshold', async () => {
    let releaseSecondBatch: (value: string[]) => void = () => {};
    const secondBatch = new Promise<string[]>((resolve) => {
      releaseSecondBatch = resolve;
    });
    const { service, withTransaction } = await loadKeyService([codes('x', 3), secondBatch]);

    expect(await service.getNextKey()).toBe('x000'); // waits: cache was empty
    // Two keys left (< threshold 50): a refill starts, but this call must not wait for it.
    expect(await service.getNextKey()).toBe('x001');
    expect(withTransaction).toHaveBeenCalledTimes(2);

    releaseSecondBatch(codes('y', 100));
    await vi.waitFor(() => expect(service.getLocalCacheCount()).toBe(101));
  });

  it('falls back to a random base62 code when the pool is exhausted', async () => {
    const { service } = await loadKeyService([[]]);
    const code = await service.getNextKey();
    expect(code).toMatch(/^[A-Za-z0-9]{7}$/);
  });
});

describe('generateRandomCode', () => {
  it('produces base62 codes of the requested length', async () => {
    const { service } = await loadKeyService([[]]);
    for (let i = 0; i < 50; i++) {
      expect(service.generateRandomCode(10)).toMatch(/^[A-Za-z0-9]{10}$/);
    }
  });
});

describe('reclaimStaleKeys', () => {
  it('marks keys already in urls as used and releases expired leases', async () => {
    const { service, query } = await loadKeyService([[]]);
    query.mockResolvedValueOnce([{ count: '2' }]).mockResolvedValueOnce([{ count: '5' }]);

    expect(await service.reclaimStaleKeys()).toEqual({ markedUsed: 2, released: 5 });

    expect(query.mock.calls[0][0]).toContain('FROM urls u');
    expect(query.mock.calls[1][0]).toContain('allocated_to = NULL');
    expect(query.mock.calls[1][1]).toEqual([3600]); // 60-minute lease, in seconds
  });

  it('passes a custom lease TTL through', async () => {
    const { service, query } = await loadKeyService([[]]);
    query.mockResolvedValue([{ count: '0' }]);
    await service.reclaimStaleKeys(90_000);
    expect(query.mock.calls[1][1]).toEqual([90]);
  });
});
