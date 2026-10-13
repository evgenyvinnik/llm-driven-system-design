import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';

vi.mock('../queue/redis', () => ({ redis: {} }));

import { hashPassword, verifyPassword } from './auth';

describe('password hashing', () => {
  it('round-trips with scrypt and rejects the wrong password', async () => {
    const stored = await hashPassword('admin123');
    expect(stored).toMatch(/^scrypt\$/);
    expect(await verifyPassword('admin123', stored)).toBe(true);
    expect(await verifyPassword('admin124', stored)).toBe(false);
  });

  it('salts every hash, so equal passwords do not produce equal hashes', async () => {
    expect(await hashPassword('same')).not.toEqual(await hashPassword('same'));
  });

  it('still verifies legacy unsalted SHA-256 hashes so existing users can log in', async () => {
    const legacy = crypto.createHash('sha256').update('admin123').digest('hex');
    expect(await verifyPassword('admin123', legacy)).toBe(true);
    expect(await verifyPassword('nope', legacy)).toBe(false);
  });

  it('rejects malformed stored values', async () => {
    expect(await verifyPassword('x', 'scrypt$')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});
