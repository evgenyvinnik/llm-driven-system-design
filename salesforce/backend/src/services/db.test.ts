import { describe, it, expect } from 'vitest';
import { parseDate, parseInt8 } from './db.js';

describe('pg type parsers', () => {
  it('returns BIGINT cents as numbers so sums add instead of concatenating', () => {
    const amounts = ['22000000', '54000000'].map(parseInt8);
    expect(amounts.reduce((sum, a) => sum + a, 0)).toBe(76000000);
  });

  it('refuses int8 values that would lose precision as a JS number', () => {
    expect(() => parseInt8('9007199254740993')).toThrow();
  });

  it('keeps DATE columns as calendar-day strings', () => {
    expect(parseDate('2026-12-15')).toBe('2026-12-15');
  });
});
