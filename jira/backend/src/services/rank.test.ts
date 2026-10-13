import { describe, expect, it } from 'vitest';
import { isValidRank, midpoint, rankAfter, rankBetween } from './rank.js';

describe('rankAfter', () => {
  it('starts an empty list in the middle of the key space', () => {
    expect(rankAfter(null)).toBe('i00000i');
  });

  it('advances the six-character head by 36^2 so neighbours keep room between them', () => {
    expect(rankAfter('i00000i')).toBe('i00100i');
    expect(rankAfter('i00100i')).toBe('i00200i');
  });

  it('is strictly greater for short keys produced by midpoint', () => {
    for (const key of ['i', '0i', 'zz', '000001', 'i001']) {
      const next = rankAfter(key);
      expect(next > key).toBe(true);
      expect(isValidRank(next)).toBe(true);
    }
  });

  it('grows the key instead of overflowing when the head is exhausted', () => {
    const next = rankAfter('zzzzzzi');
    expect(next > 'zzzzzzi').toBe(true);
    expect(isValidRank(next)).toBe(true);
  });
});

describe('midpoint', () => {
  it('returns a key strictly between its arguments', () => {
    const cases: [string, string | null][] = [
      ['', null],
      ['', 'i'],
      ['i00000i', 'i00100i'],
      ['i00000i', 'i001'],
      ['1i', '2i'],
      ['z', null],
      ['', '0i'],
    ];
    for (const [a, b] of cases) {
      const m = midpoint(a, b);
      expect(m > a).toBe(true);
      if (b !== null) expect(m < b).toBe(true);
      expect(isValidRank(m)).toBe(true);
    }
  });

  it('rejects keys that are out of order or end in zero', () => {
    expect(() => midpoint('b', 'a')).toThrow(RangeError);
    expect(() => midpoint('a', 'a')).toThrow(RangeError);
    expect(() => midpoint('a0', 'b')).toThrow(RangeError);
  });
});

describe('rankBetween', () => {
  it('handles open ends', () => {
    expect(rankBetween(null, null)).toBe('i00000i');
    expect(rankBetween('i00000i', null)).toBe('i00100i');
    expect(rankBetween(null, 'i00000i') < 'i00000i').toBe(true);
  });

  it('keeps a list ordered under many random inserts', () => {
    // Deterministic pseudo-random sequence so a failure is reproducible.
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };

    const keys: string[] = [rankBetween(null, null)];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(random() * (keys.length + 1));
      const key = rankBetween(keys[at - 1] ?? null, keys[at] ?? null);
      keys.splice(at, 0, key);
    }

    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
    expect(keys.every(isValidRank)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    // Random inserts keep keys short; the longest stays well under the 64-character mark.
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(20);
  });

  it('grows by about one character per five inserts at the same spot', () => {
    let top = rankBetween(null, null);
    for (let i = 0; i < 50; i++) top = rankBetween(null, top);
    expect(top.length).toBeLessThanOrEqual(12);
  });
});
