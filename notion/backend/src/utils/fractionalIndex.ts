/**
 * Fractional indexing for ordering blocks
 * Based on: https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
 *
 * This allows inserting items between any two existing items without reindexing.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;

/**
 * Generate a position string between two existing positions
 * @param before - The position before (or empty string for start)
 * @param after - The position after (or empty string for end)
 * @returns A new position string that sorts between before and after
 */
export function generatePosition(before: string = '', after: string = ''): string {
  // Handle edge cases
  if (!before && !after) {
    return 'n'; // Middle of alphabet
  }

  if (!before) {
    // Insert at the beginning
    return decrementPosition(after);
  }

  if (!after) {
    // Insert at the end
    return incrementPosition(before);
  }

  // Insert between two positions
  return midpoint(before, after);
}

/**
 * Calculate midpoint between two position strings
 */
function midpoint(a: string, b: string): string {
  // Ensure a < b
  if (a >= b) {
    throw new Error(`Cannot find midpoint: ${a} >= ${b}`);
  }

  // Pad to same length
  const maxLen = Math.max(a.length, b.length);
  const paddedA = a.padEnd(maxLen, 'a');
  const paddedB = b.padEnd(maxLen, 'z');

  // Find midpoint character by character
  let result = '';
  let carry = 0;

  for (let i = 0; i < maxLen; i++) {
    const charA = ALPHABET.indexOf(paddedA[i]) + carry;
    const charB = ALPHABET.indexOf(paddedB[i]);

    if (charA < charB) {
      const mid = Math.floor((charA + charB) / 2);
      result += ALPHABET[mid];

      if (result > a && result < b) {
        return result;
      }

      // Need more precision
      carry = (charA + charB) % 2 * BASE;
    } else {
      result += paddedA[i];
    }
  }

  // If we get here, we need to append a character
  result += 'n';
  return result;
}

/**
 * Increment a position (for inserting after)
 */
function incrementPosition(pos: string): string {
  if (!pos) return 'n';

  const chars = pos.split('');
  let i = chars.length - 1;

  while (i >= 0) {
    const charIndex = ALPHABET.indexOf(chars[i]);
    if (charIndex < BASE - 1) {
      chars[i] = ALPHABET[charIndex + 1];
      return chars.join('');
    }
    chars[i] = 'a';
    i--;
  }

  // All characters were 'z', prepend 'a' and append
  return pos + 'n';
}

/**
 * Decrement a position (for inserting before)
 */
function decrementPosition(pos: string): string {
  if (!pos) return 'n';

  const chars = pos.split('');
  let i = chars.length - 1;

  while (i >= 0) {
    const charIndex = ALPHABET.indexOf(chars[i]);
    if (charIndex > 0) {
      chars[i] = ALPHABET[charIndex - 1];
      return chars.join('');
    }
    chars[i] = 'z';
    i--;
  }

  // All characters were 'a', this shouldn't happen often
  return 'a' + pos.slice(0, -1) + 'n';
}

/**
 * Generate multiple positions for bulk insert
 * @param before - Position before first item
 * @param after - Position after last item
 * @param count - Number of positions to generate
 */
export function generatePositions(before: string, after: string, count: number): string[] {
  const positions: string[] = [];
  let current = before;

  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    const next = isLast ? after : '';
    current = generatePosition(current, next);
    positions.push(current);
  }

  return positions;
}

/**
 * Compare two position strings
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function comparePositions(a: string, b: string): number {
  return a.localeCompare(b);
}
