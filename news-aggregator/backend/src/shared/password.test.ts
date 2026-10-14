import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('round-trips with a per-hash salt', async () => {
    const a = await hashPassword('password123');
    const b = await hashPassword('password123');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('password123', a)).toEqual({ valid: true, needsRehash: false });
    expect((await verifyPassword('wrong', a)).valid).toBe(false);
  });

  it('accepts the legacy salted SHA-256 seed hash and asks for a rehash', async () => {
    // backend/db-seed/base.sql: admin@newsagg.local / password123
    const legacy = 'f3ab6d7f779ddc29da66448ff3711af1df1289c9de16f5d76c918d9f3ef63b2e';
    expect(await verifyPassword('password123', legacy)).toEqual({ valid: true, needsRehash: true });
    expect(await verifyPassword('admin123', legacy)).toEqual({ valid: false, needsRehash: false });
  });

  it('rejects malformed hashes', async () => {
    expect((await verifyPassword('x', 'not-a-hash')).valid).toBe(false);
    expect((await verifyPassword('x', 'scrypt$abc$8$1$c2FsdA==$aGFzaA==')).valid).toBe(false);
  });
});
