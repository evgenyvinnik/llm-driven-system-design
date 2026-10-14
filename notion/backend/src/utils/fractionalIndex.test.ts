import { describe, it, expect } from 'vitest';
import {
  generateKeyBetween,
  generateNKeysBetween,
  generatePosition,
  isPositionTooLong,
  PositionError,
} from './fractionalIndex.js';

/** Inserts `count` keys at random gaps and returns the resulting ordered list. */
function randomInserts(count: number, seed = 42): string[] {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.floor(random() * (keys.length + 1));
    const key = generateKeyBetween(keys[index - 1] ?? null, keys[index] ?? null);
    keys.splice(index, 0, key);
  }
  return keys;
}

describe('generateKeyBetween', () => {
  it('starts in the middle of the alphabet and appends after the last key', () => {
    expect(generateKeyBetween(null, null)).toBe('n');
    expect(generateKeyBetween('n', null) > 'n').toBe(true);
  });

  it('returns a key strictly between its bounds', () => {
    const key = generateKeyBetween('b', 'c');
    expect(key > 'b' && key < 'c').toBe(true);
  });

  it('keeps every key ordered and unique under 2,000 random inserts', () => {
    const keys = randomInserts(2000);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never produces a key ending in the zero digit "a"', () => {
    const keys = randomInserts(2000, 7);
    expect(keys.some((key) => key.endsWith('a'))).toBe(false);
  });

  it('can always insert before the first key (the old generator returned a larger key after 13 prepends)', () => {
    let first = generateKeyBetween(null, null);
    for (let i = 0; i < 200; i++) {
      const before = generateKeyBetween(null, first);
      expect(before < first).toBe(true);
      first = before;
    }
  });

  it('accepts legacy keys that end in "a" as bounds', () => {
    const between = generateKeyBetween('a', 'b');
    expect(between > 'a' && between < 'b').toBe(true);
    const after = generateKeyBetween('ba', null);
    expect(after > 'ba').toBe(true);
  });

  it('throws PositionError when no key fits', () => {
    expect(() => generateKeyBetween('c', 'c')).toThrow(PositionError);
    expect(() => generateKeyBetween('d', 'c')).toThrow(PositionError);
    expect(() => generateKeyBetween(null, 'a')).toThrow(PositionError);
    expect(() => generateKeyBetween('b', 'ba')).toThrow(PositionError);
    expect(() => generateKeyBetween('B', null)).toThrow(PositionError);
  });

  it('grows about one character per ~5 inserts into the same gap', () => {
    let upper = 'o';
    for (let i = 0; i < 100; i++) upper = generateKeyBetween('n', upper);
    expect(upper.length).toBeGreaterThan(10);
    expect(upper.length).toBeLessThan(30);
  });

  it('keeps the old generatePosition signature', () => {
    expect(generatePosition('', '')).toBe('n');
    expect(generatePosition('a', 'c')).toBe('b');
  });
});

describe('generateNKeysBetween', () => {
  it('spreads keys evenly and in order', () => {
    const keys = generateNKeysBetween(null, null, 500);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(500);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(4);
  });

  it('fits keys inside tight bounds', () => {
    const keys = generateNKeysBetween('b', 'c', 50);
    expect(keys.every((key) => key > 'b' && key < 'c')).toBe(true);
    expect(keys).toEqual([...keys].sort());
  });

  it('flags keys that need a rebalance', () => {
    expect(isPositionTooLong('n'.repeat(48))).toBe(false);
    expect(isPositionTooLong('n'.repeat(49))).toBe(true);
  });
});
