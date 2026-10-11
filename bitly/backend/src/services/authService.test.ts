import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/database.js', () => ({
  query: vi.fn(),
}));

vi.mock('../utils/cache.js', () => ({
  sessionCache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

import { query } from '../utils/database.js';
import { sessionCache } from '../utils/cache.js';
import { sessionCacheTtlSeconds, getUserByToken, logoutUser } from './authService.js';

const user = {
  id: 'user-1',
  email: 'alice@example.com',
  password_hash: 'hash',
  role: 'user',
  created_at: new Date('2026-01-01T00:00:00Z'),
  is_active: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sessionCacheTtlSeconds', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);

  it('is the remaining session lifetime, not a fresh 7 days', () => {
    expect(sessionCacheTtlSeconds(new Date(now + 3 * 3600 * 1000), now)).toBe(10800);
  });

  it('is capped at the configured 7-day ceiling', () => {
    expect(sessionCacheTtlSeconds(new Date(now + 30 * 86400 * 1000), now)).toBe(7 * 86400);
  });

  it('is 0 for sessions that already expired', () => {
    expect(sessionCacheTtlSeconds(new Date(now - 1000), now)).toBe(0);
  });
});

describe('getUserByToken', () => {
  it('re-caches a session only for its remaining lifetime', async () => {
    vi.mocked(sessionCache.get).mockResolvedValue(null);
    const expiresAt = new Date(Date.now() + 2 * 3600 * 1000);
    vi.mocked(query)
      .mockResolvedValueOnce([{ id: 's1', user_id: 'user-1', token: 't', created_at: new Date(), expires_at: expiresAt }])
      .mockResolvedValueOnce([user]);

    const result = await getUserByToken('t');

    expect(result?.id).toBe('user-1');
    const ttl = vi.mocked(sessionCache.set).mock.calls[0][2];
    expect(ttl).toBeGreaterThan(7190);
    expect(ttl).toBeLessThanOrEqual(7200);
  });

  it('falls back to PostgreSQL when the session cache errors', async () => {
    vi.mocked(sessionCache.get).mockRejectedValue(new Error('Redis not connected'));
    vi.mocked(query)
      .mockResolvedValueOnce([
        { id: 's1', user_id: 'user-1', token: 't', created_at: new Date(), expires_at: new Date(Date.now() + 60_000) },
      ])
      .mockResolvedValueOnce([user]);

    await expect(getUserByToken('t')).resolves.toMatchObject({ id: 'user-1' });
  });

  it('still authenticates when re-caching fails', async () => {
    vi.mocked(sessionCache.get).mockResolvedValue(null);
    vi.mocked(sessionCache.set).mockRejectedValue(new Error('Redis not connected'));
    vi.mocked(query)
      .mockResolvedValueOnce([
        { id: 's1', user_id: 'user-1', token: 't', created_at: new Date(), expires_at: new Date(Date.now() + 60_000) },
      ])
      .mockResolvedValueOnce([user]);

    await expect(getUserByToken('t')).resolves.toMatchObject({ id: 'user-1' });
  });
});

describe('logoutUser', () => {
  it('evicts the cache, deletes the session row, then evicts again', async () => {
    const order: string[] = [];
    vi.mocked(sessionCache.delete).mockImplementation(async () => {
      order.push('cache');
    });
    vi.mocked(query).mockImplementation(async () => {
      order.push('sql');
      return [];
    });

    await logoutUser('t');

    expect(order).toEqual(['cache', 'sql', 'cache']);
  });

  it('fails without touching SQL when the cache eviction fails', async () => {
    vi.mocked(sessionCache.delete).mockRejectedValue(new Error('Redis down'));

    await expect(logoutUser('t')).rejects.toThrow('Redis down');
    expect(query).not.toHaveBeenCalled();
  });
});
