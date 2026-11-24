import { describe, it, expect, vi } from 'vitest';

vi.mock('../models/database.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../models/redis.js', () => ({ redis: {}, REDIS_KEYS: { AUTH_USER: (id: number) => `auth:${id}` } }));

import {
  hashPassword,
  verifyPassword,
  normalizeUsername,
  validatePassword,
  validateRole,
  UserError,
} from './users.js';

describe('password hashing', () => {
  it('round-trips and rejects wrong passwords', async () => {
    const encoded = await hashPassword('correct horse');
    expect(encoded).toMatch(/^pbkdf2_sha512\$210000\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(await verifyPassword('correct horse', encoded)).toBe(true);
    expect(await verifyPassword('correct horsf', encoded)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('honors the stored iteration count (so it can be raised later)', async () => {
    const encoded = await hashPassword('pw-123456');
    const [, , salt] = encoded.split('$');
    const crypto = await import('crypto');
    const legacy = `pbkdf2_sha512$1000$${salt}$${crypto
      .pbkdf2Sync('pw-123456', salt, 1000, 64, 'sha512')
      .toString('hex')}`;
    expect(await verifyPassword('pw-123456', legacy)).toBe(true);
  });

  it('treats malformed hashes as non-matching', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'md5$1$a$b')).toBe(false);
  });
});

describe('validation', () => {
  it('normalizes usernames to lowercase and enforces the pattern', () => {
    expect(normalizeUsername('  Alice.Ops ')).toBe('alice.ops');
    expect(() => normalizeUsername('ab')).toThrow(UserError);
    expect(() => normalizeUsername('-leading')).toThrow(UserError);
    expect(() => normalizeUsername('has space')).toThrow(UserError);
    expect(() => normalizeUsername(42)).toThrow(UserError);
  });

  it('requires 8-256 character passwords', () => {
    expect(validatePassword('12345678')).toBe('12345678');
    expect(() => validatePassword('short')).toThrow(/at least 8/);
    expect(() => validatePassword('x'.repeat(257))).toThrow(/at most 256/);
    expect(() => validatePassword(undefined)).toThrow(UserError);
  });

  it('accepts only known roles', () => {
    expect(validateRole('admin')).toBe('admin');
    expect(validateRole('user')).toBe('user');
    expect(() => validateRole('root')).toThrow(UserError);
  });
});
