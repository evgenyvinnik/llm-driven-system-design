/**
 * Unit tests for idempotency-key helpers (services/idempotency.ts).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { fingerprintCreatePost, isValidIdempotencyKey } from './idempotency.js';

const base = {
  caption: 'Golden hour',
  location: 'Colorado',
  filters: ['clarendon'],
  files: [{ buffer: Buffer.from('image-bytes-1') }],
};

describe('fingerprintCreatePost', () => {
  it('is stable for the same request', () => {
    expect(fingerprintCreatePost(base)).toBe(fingerprintCreatePost({ ...base, files: [{ buffer: Buffer.from('image-bytes-1') }] }));
    expect(fingerprintCreatePost(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the caption, a filter or any file byte changes', () => {
    const original = fingerprintCreatePost(base);
    expect(fingerprintCreatePost({ ...base, caption: 'Golden hour!' })).not.toBe(original);
    expect(fingerprintCreatePost({ ...base, filters: ['moon'] })).not.toBe(original);
    expect(fingerprintCreatePost({ ...base, files: [{ buffer: Buffer.from('image-bytes-2') }] })).not.toBe(original);
  });
});

describe('isValidIdempotencyKey', () => {
  it('accepts UUIDs and rejects short or unsafe keys', () => {
    expect(isValidIdempotencyKey('5f0c7a62-4c1e-4f5b-9d3e-1b2c3d4e5f60')).toBe(true);
    expect(isValidIdempotencyKey('short')).toBe(false);
    expect(isValidIdempotencyKey('has spaces in it')).toBe(false);
  });
});
