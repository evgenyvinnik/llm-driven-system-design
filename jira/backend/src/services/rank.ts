/**
 * Rank keys for board and backlog ordering (a simplified LexoRank).
 *
 * A rank is a base-36 string ('0'-'9', 'a'-'z') compared byte-wise. PostgreSQL stores
 * it in a COLLATE "C" column so ORDER BY rank and JavaScript string comparison agree.
 * Moving an issue rewrites only that issue's key: the new key is chosen strictly between
 * its new neighbours, so no other row is renumbered.
 *
 * Two operations:
 * - rankAfter(prev): used when appending. Reads the first six characters as a base-36
 *   integer and advances it by 36^2, leaving 1,296 slots between appended issues for
 *   later inserts. The SQL function jira_rank_after() in db/init.sql mirrors it so new
 *   rows get a rank from a trigger whatever inserts them.
 * - midpoint(a, b): used when inserting between two neighbours. Treats keys as base-36
 *   fractions (0.a, 0.b) and returns a short key strictly between them. Keys never end
 *   in '0', otherwise "x" and "x0" would be equal and leave no room between them.
 */

export const RANK_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

const BASE = RANK_DIGITS.length;
const HEAD_LENGTH = 6;
const STEP = BASE * BASE;
const MAX_HEAD = BASE ** HEAD_LENGTH - 1;
const FIRST_HEAD = Math.floor((MAX_HEAD + 1) / 2);
const TAIL = 'i';

const VALID_RANK = /^[0-9a-z]*[1-9a-z]$/;

/** True for a non-empty base-36 key that does not end in '0'. */
export function isValidRank(rank: string): boolean {
  return VALID_RANK.test(rank);
}

function encodeHead(value: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < HEAD_LENGTH; i++) {
    out = RANK_DIGITS[rest % BASE] + out;
    rest = Math.floor(rest / BASE);
  }
  return out;
}

function decodeHead(head: string): number {
  let value = 0;
  for (const char of head) {
    value = value * BASE + RANK_DIGITS.indexOf(char);
  }
  return value;
}

/**
 * Returns a key strictly between a and b, where '' is the lowest possible key and a null
 * b means "no upper bound". Port of the midpoint step from the fractional-indexing
 * algorithm (David Greenspan, "Implementing Fractional Indexing").
 */
export function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new RangeError(`Rank "${a}" is not below "${b}"`);
  }
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) {
    throw new RangeError('Rank keys never end in "0"');
  }

  if (b !== null) {
    // Skip the common prefix, reading a missing digit of a as '0'.
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const digitA = a ? RANK_DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? RANK_DIGITS.indexOf(b[0]) : BASE;

  if (digitB - digitA > 1) {
    return RANK_DIGITS[Math.round((digitA + digitB) / 2)];
  }
  // The first digits are adjacent.
  if (b !== null && b.length > 1) {
    return b.slice(0, 1);
  }
  return RANK_DIGITS[digitA] + midpoint(a.slice(1), null);
}

/** A key strictly greater than prev, or the first key of an empty list when prev is null. */
export function rankAfter(prev: string | null): string {
  if (prev === null) return encodeHead(FIRST_HEAD) + TAIL;
  const head = decodeHead(prev.slice(0, HEAD_LENGTH).padEnd(HEAD_LENGTH, '0'));
  if (head + STEP <= MAX_HEAD) return encodeHead(head + STEP) + TAIL;
  // The integer space is exhausted (after ~1.7M appends): fall back to growing keys.
  return midpoint(prev, null);
}

/**
 * Key for an issue placed between the issue above it (lower key) and the issue below it
 * (higher key). Either side may be null for the top or bottom of the list.
 */
export function rankBetween(lower: string | null, upper: string | null): string {
  if (upper === null) return rankAfter(lower);
  return midpoint(lower ?? '', upper);
}
