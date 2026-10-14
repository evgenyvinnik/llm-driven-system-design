/**
 * @fileoverview Fractional indexing for ordering blocks, pages and database rows.
 * Based on: https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
 * and the midpoint algorithm popularized by rocicorp/fractional-indexing.
 *
 * A position is a string over the digits a-z read as a base-26 fraction
 * ("n" is 0.5, "an" is 0.019...). Byte-wise string order equals numeric order,
 * so inserting between two siblings is a single-row write that touches nothing
 * else. Only lowercase ASCII is used, so PostgreSQL collations and JavaScript
 * string comparison agree on the order.
 *
 * Invariant: a generated key never ends in the zero digit "a". "b" and "ba" are
 * the same fraction but different strings and nothing sorts between them, so a
 * trailing zero creates a gap that can never be split. Keys written by older
 * code (and old seed data) may still end in "a"; they are accepted as bounds by
 * stripping the trailing zeros first. When no key fits (duplicate positions, or
 * a bound that is all zeros) generateKeyBetween throws PositionError and the
 * caller rebalances the sibling list.
 */

const DIGITS = 'abcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];

/** Keys longer than this make the server rebalance the sibling list. */
export const MAX_POSITION_LENGTH = 48;

/** Thrown when no key exists between the given bounds. */
export class PositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionError';
  }
}

function assertValidKey(key: string): void {
  if (!/^[a-z]+$/.test(key)) {
    throw new PositionError(`Invalid position "${key}"`);
  }
}

function stripTrailingZeros(key: string): string {
  let end = key.length;
  while (end > 0 && key[end - 1] === ZERO) end--;
  return key.slice(0, end);
}

/**
 * Midpoint of two fractions written as digit strings. `a` may be '' (zero) and
 * `b` null (one). Neither ends in the zero digit, and a < b.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Copy the shared prefix ("a" pads the shorter lower bound) and recurse.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;

  if (digitB - digitA > 1) {
    return DIGITS[Math.round((digitA + digitB) / 2)];
  }

  // Consecutive first digits: either a shorter key fits ("bz" < "c" < "cn"),
  // or keep a's first digit and find a midpoint above the rest of a.
  if (b !== null && b.length > 1) {
    return b.slice(0, 1);
  }
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/**
 * Returns a key that sorts strictly between `before` and `after`.
 * A missing bound means "start of list" / "end of list".
 *
 * @throws PositionError when no such key exists
 */
export function generateKeyBetween(
  before: string | null | undefined,
  after: string | null | undefined
): string {
  if (before) assertValidKey(before);
  if (after) assertValidKey(after);

  const lower = before ? stripTrailingZeros(before) : '';
  if (!after) {
    return midpoint(lower, null);
  }

  const upper = stripTrailingZeros(after);
  if (upper === '') {
    throw new PositionError(`No position sorts before "${after}"`);
  }
  if (lower >= upper) {
    throw new PositionError(`No position fits between "${before}" and "${after}"`);
  }
  return midpoint(lower, upper);
}

/**
 * Backwards-compatible wrapper: empty strings mean an open bound.
 */
export function generatePosition(before: string = '', after: string = ''): string {
  return generateKeyBetween(before || null, after || null);
}

/**
 * Returns `count` evenly spread keys between two bounds, in order. Used to
 * rebalance a sibling list: halving the interval recursively keeps every key
 * about log26(count) characters long.
 */
export function generateNKeysBetween(
  before: string | null,
  after: string | null,
  count: number
): string[] {
  if (count <= 0) return [];
  const middleIndex = Math.floor(count / 2);
  const middle = generateKeyBetween(before, after);
  return [
    ...generateNKeysBetween(before, middle, middleIndex),
    middle,
    ...generateNKeysBetween(middle, after, count - middleIndex - 1),
  ];
}

/** True when a key has grown long enough that its siblings should be rebalanced. */
export function isPositionTooLong(key: string): boolean {
  return key.length > MAX_POSITION_LENGTH;
}

/**
 * Byte-wise comparison (not localeCompare), matching ORDER BY position.
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function comparePositions(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
