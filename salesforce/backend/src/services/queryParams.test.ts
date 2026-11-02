import { describe, it, expect } from 'vitest';
import { containsPattern, optionalDate, optionalNonNegativeInt, parsePagination } from './queryParams.js';
import { HttpError } from './accessPolicy.js';

describe('parsePagination', () => {
  it('falls back to defaults for missing, negative or non-numeric input', () => {
    expect(parsePagination({}, 20)).toEqual({ page: 1, limit: 20, offset: 0 });
    expect(parsePagination({ page: 'abc', limit: '-1' }, 20)).toEqual({ page: 1, limit: 20, offset: 0 });
    expect(parsePagination({ page: '0', limit: '0' }, 20)).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  it('caps the limit and computes the offset', () => {
    expect(parsePagination({ page: '3', limit: '100000' }, 20)).toEqual({ page: 3, limit: 200, offset: 400 });
    expect(parsePagination({ page: '2', limit: '10' }, 20)).toEqual({ page: 2, limit: 10, offset: 10 });
  });
});

describe('containsPattern', () => {
  it('escapes LIKE wildcards so they match literally', () => {
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    expect(containsPattern('acme')).toBe('%acme%');
  });
});

describe('optionalNonNegativeInt', () => {
  it('accepts whole numbers and numeric strings, treats empty as absent', () => {
    expect(optionalNonNegativeInt(1250, 'amountCents')).toBe(1250);
    expect(optionalNonNegativeInt('1250', 'amountCents')).toBe(1250);
    expect(optionalNonNegativeInt('', 'amountCents')).toBeUndefined();
    expect(optionalNonNegativeInt(undefined, 'amountCents')).toBeUndefined();
  });

  it('rejects fractions, negatives and junk with a 400', () => {
    for (const bad of [12.5, -1, 'abc', '1e400', {}]) {
      expect(() => optionalNonNegativeInt(bad, 'amountCents')).toThrow(HttpError);
    }
  });
});

describe('optionalDate', () => {
  it('accepts YYYY-MM-DD and rejects anything else', () => {
    expect(optionalDate('2026-12-15', 'closeDate')).toBe('2026-12-15');
    expect(() => optionalDate('12/15/2026', 'closeDate')).toThrow(HttpError);
    expect(() => optionalDate('2026-13-45', 'closeDate')).toThrow(HttpError);
  });
});
