/**
 * @fileoverview Simple UUID v4 generator for client-side ID generation.
 * Used for creating temporary block IDs and operation IDs before server confirmation.
 */

/**
 * Generates a random UUID v4 string.
 * Uses Math.random() which is sufficient for temporary client IDs.
 *
 * @returns A UUID v4 string in the format xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function v4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
