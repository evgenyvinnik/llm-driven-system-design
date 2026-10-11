import { describe, it, expect } from 'vitest';
import { hashCode, hashRequest, normalizeCode, parseIdempotencyKey } from './idempotency.js';

describe('parseIdempotencyKey', () => {
  it('treats a missing header as "no key"', () => {
    expect(parseIdempotencyKey(undefined)).toEqual({ ok: true, key: null });
  });

  it('accepts a UUID and trims surrounding whitespace', () => {
    expect(parseIdempotencyKey(' 7f8c2a8e-1b9d-4c43-9d55-0c3c1d2b4e6f ')).toEqual({
      ok: true,
      key: '7f8c2a8e-1b9d-4c43-9d55-0c3c1d2b4e6f',
    });
  });

  it('rejects empty, oversized, non-ASCII and repeated headers', () => {
    expect(parseIdempotencyKey('').ok).toBe(false);
    expect(parseIdempotencyKey('x'.repeat(256)).ok).toBe(false);
    expect(parseIdempotencyKey('ключ').ok).toBe(false);
    expect(parseIdempotencyKey('has space').ok).toBe(false);
    expect(parseIdempotencyKey(['a', 'b']).ok).toBe(false);
  });
});

describe('hashCode', () => {
  it('is stable for the same code', () => {
    expect(hashCode('def solve(): pass')).toBe(hashCode('def solve(): pass'));
  });

  it('ignores trailing whitespace and line-ending differences', () => {
    expect(hashCode('def solve(): pass  ')).toBe(hashCode('def solve(): pass'));
    expect(hashCode('line1\r\nline2')).toBe(hashCode('line1\nline2'));
    expect(normalizeCode('  a  \n')).toBe('a');
  });

  it('changes when the code changes', () => {
    expect(hashCode('def solve(): pass')).not.toBe(hashCode('def solve(): return 1'));
  });
});

describe('hashRequest', () => {
  const body = { problemSlug: 'two-sum', language: 'python', code: 'print(1)' };

  it('is stable for the same body', () => {
    expect(hashRequest(body)).toBe(hashRequest({ ...body }));
  });

  it('distinguishes problem, language and exact code', () => {
    expect(hashRequest(body)).not.toBe(hashRequest({ ...body, problemSlug: 'fizzbuzz' }));
    expect(hashRequest(body)).not.toBe(hashRequest({ ...body, language: 'javascript' }));
    // Exact body, not normalized: a key reused with different whitespace is a different request.
    expect(hashRequest(body)).not.toBe(hashRequest({ ...body, code: 'print(1) ' }));
  });

  it('cannot be confused by field boundaries', () => {
    expect(hashRequest({ problemSlug: 'a', language: 'bc', code: 'd' }))
      .not.toBe(hashRequest({ problemSlug: 'ab', language: 'c', code: 'd' }));
  });
});
