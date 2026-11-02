import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('./logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { pool } from './db.js';
import { decryptSecret, encryptLegacyPasswords, encryptSecret, isEncrypted } from './credentials.js';
import { ApiError } from './errors.js';

const query = vi.mocked(pool.query);

beforeEach(() => query.mockReset());

describe('target credential encryption', () => {
  it('round-trips and never stores the plaintext', () => {
    const stored = encryptSecret('s3cr3t@host/db');
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('s3cr3t');
    expect(decryptSecret(stored)).toBe('s3cr3t@host/db');
  });

  it('uses a fresh IV, so equal passwords produce different ciphertexts', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('reads legacy plaintext rows as-is', () => {
    expect(decryptSecret('sample123')).toBe('sample123');
  });

  it('refuses tampered ciphertext with a clear error instead of returning garbage', () => {
    const stored = encryptSecret('password');
    const tampered = stored.slice(0, -4) + (stored.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decryptSecret(tampered)).toThrow(ApiError);
  });

  it('encrypts legacy rows with a compare-and-set update', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'p1', db_password: 'sample123' }] } as never);
    query.mockResolvedValueOnce({ rowCount: 1 } as never);

    expect(await encryptLegacyPasswords()).toBe(1);
    const [sql, params] = query.mock.calls[1] as unknown as [string, string[]];
    expect(sql).toMatch(/WHERE id = \$2 AND db_password = \$3/);
    expect(isEncrypted(params[0])).toBe(true);
    expect(decryptSecret(params[0])).toBe('sample123');
    expect(params.slice(1)).toEqual(['p1', 'sample123']);
  });
});
