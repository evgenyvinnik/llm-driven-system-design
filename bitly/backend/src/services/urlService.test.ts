import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';

// Mock shared modules before importing the service
vi.mock('../utils/database.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../utils/cache.js', () => ({
  urlCache: {
    lookup: vi.fn(),
    fill: vi.fn().mockResolvedValue(undefined),
    fillNegative: vi.fn().mockResolvedValue(undefined),
    prime: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
  },
  isCachedUrlLive: (entry: { expiresAt: number | null }, now: number) =>
    entry.expiresAt === null || entry.expiresAt > now,
}));

vi.mock('./keyService.js', () => ({
  getNextKey: vi.fn(),
  markKeyAsUsed: vi.fn().mockResolvedValue(undefined),
  isCodeAvailable: vi.fn().mockResolvedValue(true),
}));

import { query, withTransaction } from '../utils/database.js';
import { urlCache } from '../utils/cache.js';
import { getNextKey, markKeyAsUsed, isCodeAvailable } from './keyService.js';
import { HttpError } from '../utils/errors.js';
import {
  validateCustomCode,
  validateExpiresIn,
  isWellFormedShortCode,
  canAccessUrl,
  createUrl,
  resolveShortCode,
} from './urlService.js';

const uniqueViolation = (): Error => Object.assign(new Error('duplicate key'), { code: '23505' });

function urlRow(shortCode: string, overrides: Record<string, unknown> = {}) {
  return {
    short_code: shortCode,
    long_url: 'https://example.com/page',
    user_id: null,
    created_at: new Date('2026-10-10T12:00:00Z'),
    expires_at: null,
    click_count: '0',
    is_active: true,
    is_custom: false,
    ...overrides,
  };
}

/**
 * Runs withTransaction callbacks against a fake client whose INSERT behavior is scripted.
 * @param insertResults - per transaction: an Error to throw, or the row to return
 */
function scriptTransactions(insertResults: Array<Error | Record<string, unknown>>) {
  const clients: Array<{ query: ReturnType<typeof vi.fn> }> = [];
  let call = 0;
  vi.mocked(withTransaction).mockImplementation(async (callback) => {
    const result = insertResults[call++];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO urls')) {
          if (result instanceof Error) throw result;
          return { rows: [result] };
        }
        return { rows: [] };
      }),
    };
    clients.push(client);
    return callback(client as unknown as PoolClient);
  });
  return clients;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateCustomCode', () => {
  it('accepts 4 to 10 allowed characters (matches VARCHAR(10))', () => {
    expect(validateCustomCode('abcd')).toEqual({ valid: true });
    expect(validateCustomCode('my-link_10')).toEqual({ valid: true });
  });

  it('rejects codes outside 4-10 characters', () => {
    expect(validateCustomCode('abc')).toEqual({ valid: false, error: 'Custom code must be at least 4 characters' });
    expect(validateCustomCode('abcdefghijk')).toEqual({
      valid: false,
      error: 'Custom code must be at most 10 characters',
    });
  });

  it('rejects characters outside [A-Za-z0-9_-]', () => {
    expect(validateCustomCode('bad code').valid).toBe(false);
    expect(validateCustomCode('dots.dots').valid).toBe(false);
  });

  it('rejects reserved route names case-insensitively', () => {
    for (const code of ['metrics', 'READY', 'Admin', 'health', 'dashboard']) {
      expect(validateCustomCode(code)).toEqual({ valid: false, error: 'This short code is reserved' });
    }
  });
});

describe('validateExpiresIn', () => {
  it('treats absent values as "never expires"', () => {
    expect(validateExpiresIn(undefined)).toEqual({ valid: true, seconds: null });
    expect(validateExpiresIn(null)).toEqual({ valid: true, seconds: null });
  });

  it('accepts positive numbers and numeric strings', () => {
    expect(validateExpiresIn(3600)).toEqual({ valid: true, seconds: 3600 });
    expect(validateExpiresIn('60')).toEqual({ valid: true, seconds: 60 });
  });

  it('rejects values that would create an already-expired or invalid link', () => {
    for (const value of [0, -5, 'soon', Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      expect(validateExpiresIn(value).valid).toBe(false);
    }
  });

  it('rejects values beyond the 10-year cap', () => {
    expect(validateExpiresIn(11 * 365 * 24 * 3600).valid).toBe(false);
  });
});

describe('isWellFormedShortCode', () => {
  it('accepts generated and custom code shapes', () => {
    expect(isWellFormedShortCode('abc123x')).toBe(true);
    expect(isWellFormedShortCode('ai-news')).toBe(true);
  });

  it('rejects codes that cannot exist', () => {
    expect(isWellFormedShortCode('favicon.ico')).toBe(false);
    expect(isWellFormedShortCode('elevenchars')).toBe(false);
    expect(isWellFormedShortCode('')).toBe(false);
  });
});

describe('canAccessUrl', () => {
  const owner = { id: 'user-1', role: 'user' as const };
  const other = { id: 'user-2', role: 'user' as const };
  const admin = { id: 'admin-1', role: 'admin' as const };

  it('allows the owner and admins only', () => {
    expect(canAccessUrl('user-1', owner)).toBe(true);
    expect(canAccessUrl('user-1', other)).toBe(false);
    expect(canAccessUrl('user-1', admin)).toBe(true);
  });

  it('limits anonymous links to admins', () => {
    expect(canAccessUrl(null, owner)).toBe(false);
    expect(canAccessUrl(null, admin)).toBe(true);
    expect(canAccessUrl('user-1', undefined)).toBe(false);
  });
});

describe('createUrl', () => {
  it('inserts the link and marks the pool key used in the same transaction', async () => {
    vi.mocked(getNextKey).mockResolvedValueOnce('abc1234');
    scriptTransactions([urlRow('abc1234')]);

    const created = await createUrl({ long_url: 'https://example.com/page' });

    expect(created.short_code).toBe('abc1234');
    expect(created.is_active).toBe(true);
    expect(created.click_count).toBe(0);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(markKeyAsUsed).toHaveBeenCalledWith('abc1234', expect.anything()); // with the tx client
    expect(urlCache.prime).toHaveBeenCalledWith('abc1234', { url: 'https://example.com/page', expiresAt: null });
  });

  it('retries with a fresh key after a unique violation and retires the collided key', async () => {
    vi.mocked(getNextKey).mockResolvedValueOnce('taken01').mockResolvedValueOnce('fresh02');
    scriptTransactions([uniqueViolation(), urlRow('fresh02')]);

    const created = await createUrl({ long_url: 'https://example.com/page' });

    expect(created.short_code).toBe('fresh02');
    expect(getNextKey).toHaveBeenCalledTimes(2);
    expect(markKeyAsUsed).toHaveBeenCalledWith('taken01'); // outside the failed transaction
  });

  it('gives up with 503 after three collisions', async () => {
    vi.mocked(getNextKey).mockResolvedValue('taken01');
    scriptTransactions([uniqueViolation(), uniqueViolation(), uniqueViolation()]);

    await expect(createUrl({ long_url: 'https://example.com/page' })).rejects.toMatchObject({ status: 503 });
    expect(withTransaction).toHaveBeenCalledTimes(3);
    expect(urlCache.prime).not.toHaveBeenCalled();
  });

  it('does not retry on other database errors', async () => {
    vi.mocked(getNextKey).mockResolvedValue('abc1234');
    scriptTransactions([Object.assign(new Error('connection lost'), { code: '57P01' })]);

    await expect(createUrl({ long_url: 'https://example.com/page' })).rejects.toThrow('connection lost');
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('maps a custom-code race lost at insert time to 409', async () => {
    scriptTransactions([uniqueViolation()]);

    const attempt = createUrl({ long_url: 'https://example.com/page', custom_code: 'promo' });
    await expect(attempt).rejects.toBeInstanceOf(HttpError);
    await expect(attempt).rejects.toMatchObject({ status: 409, message: 'This custom code is already taken' });
  });

  it('rejects a custom code the pre-check reports as taken without inserting', async () => {
    vi.mocked(isCodeAvailable).mockResolvedValueOnce(false);
    await expect(
      createUrl({ long_url: 'https://example.com/page', custom_code: 'promo' })
    ).rejects.toMatchObject({ status: 409 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('rejects invalid input with 400 before touching the database', async () => {
    await expect(createUrl({ long_url: 'ftp://example.com' })).rejects.toMatchObject({ status: 400 });
    await expect(createUrl({ long_url: 'https://example.com', expires_in: -60 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      createUrl({ long_url: 'https://example.com', custom_code: 'waytoolongcode' })
    ).rejects.toMatchObject({ status: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('caches an expiring link with its expiry', async () => {
    vi.mocked(getNextKey).mockResolvedValueOnce('exp1234');
    const expiresAt = new Date(Date.now() + 60_000);
    scriptTransactions([urlRow('exp1234', { expires_at: expiresAt })]);

    await createUrl({ long_url: 'https://example.com/page', expires_in: 60 });

    expect(urlCache.prime).toHaveBeenCalledWith('exp1234', {
      url: 'https://example.com/page',
      expiresAt: expiresAt.getTime(),
    });
  });
});

describe('resolveShortCode', () => {
  it('rejects impossible codes without touching cache or database', async () => {
    expect(await resolveShortCode('favicon.ico')).toEqual({ found: false, source: 'invalid' });
    expect(urlCache.lookup).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('serves a live cache hit', async () => {
    vi.mocked(urlCache.lookup).mockResolvedValue({
      entry: { url: 'https://example.com', expiresAt: Date.now() + 60_000 },
      negative: false,
    });
    expect(await resolveShortCode('abc1234')).toEqual({ found: true, longUrl: 'https://example.com', source: 'cache' });
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a cached entry whose expiry has passed', async () => {
    vi.mocked(urlCache.lookup).mockResolvedValue({
      entry: { url: 'https://example.com', expiresAt: Date.now() - 1 },
      negative: false,
    });
    expect(await resolveShortCode('abc1234')).toEqual({ found: false, source: 'cache' });
    expect(query).not.toHaveBeenCalled();
  });

  it('answers from the negative cache without a database read', async () => {
    vi.mocked(urlCache.lookup).mockResolvedValue({ entry: null, negative: true });
    expect(await resolveShortCode('nope123')).toEqual({ found: false, source: 'cache' });
    expect(query).not.toHaveBeenCalled();
  });

  it('reads PostgreSQL on a miss and back-fills the cache', async () => {
    vi.mocked(urlCache.lookup).mockResolvedValue({ entry: null, negative: false });
    vi.mocked(query).mockResolvedValue([{ long_url: 'https://example.com', expires_at: null }]);

    expect(await resolveShortCode('abc1234')).toEqual({
      found: true,
      longUrl: 'https://example.com',
      source: 'database',
    });
    expect(urlCache.fill).toHaveBeenCalledWith('abc1234', { url: 'https://example.com', expiresAt: null });
  });

  it('remembers codes that do not resolve', async () => {
    vi.mocked(urlCache.lookup).mockResolvedValue({ entry: null, negative: false });
    vi.mocked(query).mockResolvedValue([]);

    expect(await resolveShortCode('nope123')).toEqual({ found: false, source: 'database' });
    expect(urlCache.fillNegative).toHaveBeenCalledWith('nope123');
  });

  it('coalesces concurrent misses for the same code into one query', async () => {
    vi.mocked(urlCache.lookup).mockResolvedValue({ entry: null, negative: false });
    let release: (rows: unknown[]) => void = () => {};
    vi.mocked(query).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve as (rows: unknown[]) => void;
      })
    );

    const pending = Promise.all([
      resolveShortCode('hot1234'),
      resolveShortCode('hot1234'),
      resolveShortCode('hot1234'),
    ]);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    release([{ long_url: 'https://example.com/hot', expires_at: null }]);

    const results = await pending;
    expect(results.every((r) => r.found && r.longUrl === 'https://example.com/hot')).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);

    // The in-flight entry is cleared afterwards, so a later miss queries again.
    vi.mocked(query).mockResolvedValueOnce([]);
    await resolveShortCode('hot1234');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
