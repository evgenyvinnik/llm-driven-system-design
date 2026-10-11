import { describe, it, expect } from 'vitest';
import { compareOutput, normalizeOutput } from './checker.js';

describe('normalizeOutput', () => {
  it('strips CRLF, trailing spaces per line and surrounding blank lines', () => {
    expect(normalizeOutput('a  \r\nb\t\r\n\n')).toBe('a\nb');
  });
});

describe('compareOutput (exact checker)', () => {
  it('ignores formatting noise', () => {
    expect(compareOutput('42\n', '42')).toBe(true);
    expect(compareOutput('42  ', '42')).toBe(true);
    expect(compareOutput('line1\r\nline2', 'line1\nline2')).toBe(true);
    expect(compareOutput('', '')).toBe(true);
    expect(compareOutput('\n\n', '')).toBe(true);
  });

  it('rejects different values', () => {
    expect(compareOutput('42', '43')).toBe(false);
    expect(compareOutput('', 'something')).toBe(false);
    expect(compareOutput('True', 'true')).toBe(false);
  });

  it('rejects output whose first number matches but whose rest does not', () => {
    // The previous comparator parsed both sides with parseFloat and accepted these.
    expect(compareOutput('1\n2\n4', '1\n2\n3')).toBe(false);
    expect(compareOutput('89\nDEBUG: memo size 45', '89')).toBe(false);
    expect(compareOutput('89abc', '89')).toBe(false);
    expect(compareOutput('8 9 10', '8')).toBe(false);
  });

  it('keeps element order for ordinary array answers', () => {
    // merge-two-sorted-lists: an unmerged concatenation used to be accepted by sorting both sides.
    expect(compareOutput('[1,2,4,1,3,4]', '[1,1,2,3,4,4]')).toBe(false);
    expect(compareOutput('["2","1","Fizz"]', '["1","2","Fizz"]')).toBe(false);
    expect(compareOutput('[1, 1, 2, 3, 4, 4]', '[1,1,2,3,4,4]')).toBe(true);
  });

  it('compares JSON structurally, including nested arrays and objects', () => {
    expect(compareOutput('[[1,2],[3,4]]', '[[1,2],[3,4]]')).toBe(true);
    expect(compareOutput('[[1,2],[4,3]]', '[[1,2],[3,4]]')).toBe(false);
    expect(compareOutput('{"b": 2, "a": 1}', '{"a":1,"b":2}')).toBe(true);
    expect(compareOutput('[0,1', '[0,1]')).toBe(false);
    expect(compareOutput('[]', '[]')).toBe(true);
  });

  it('applies a tolerance only when a decimal is involved', () => {
    expect(compareOutput('2.50000', '2.5')).toBe(true);
    expect(compareOutput('2', '2.0')).toBe(true); // JavaScript prints 2.0 as "2"
    expect(compareOutput('3.141592', '3.141593')).toBe(true);
    expect(compareOutput('3.14', '3.15')).toBe(false);
    expect(compareOutput('1000000', '1000001')).toBe(false);
    expect(compareOutput('[2.5000001, 1]', '[2.5,1]')).toBe(true);
  });
});

describe('compareOutput (unordered checker)', () => {
  it('accepts any order of the top-level array', () => {
    // two-sum: "You can return the answer in any order."
    expect(compareOutput('[1,0]', '[0,1]', 'unordered')).toBe(true);
    expect(compareOutput('[1, 0]', '[0,1]', 'unordered')).toBe(true);
  });

  it('still requires the same multiset of elements', () => {
    expect(compareOutput('[0,0]', '[0,1]', 'unordered')).toBe(false);
    expect(compareOutput('[0,1,2]', '[0,1]', 'unordered')).toBe(false);
  });

  it('does not reorder nested arrays', () => {
    expect(compareOutput('[[2,1],[3,4]]', '[[3,4],[1,2]]', 'unordered')).toBe(false);
    expect(compareOutput('[[3,4],[1,2]]', '[[1,2],[3,4]]', 'unordered')).toBe(true);
  });
});
