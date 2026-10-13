/**
 * Privacy threshold for community aggregates
 * @module shared/privacy
 */

/** The threshold may be configured, but never below this: a count of 1 identifies a reader. */
const MIN_ALLOWED_THRESHOLD = 2

function readThreshold(): number {
  const configured = parseInt(process.env.POPULAR_MIN_READERS || '5', 10)
  return Math.max(MIN_ALLOWED_THRESHOLD, Number.isFinite(configured) ? configured : 5)
}

/**
 * Minimum number of distinct readers before a passage may appear anywhere public
 * (popular, trending, heatmap). Below it the passage is not shown at all: in a small
 * readership, the mere presence of a passage says "somebody you know highlighted this".
 */
export const MIN_READERS = readThreshold()

/** Callers may ask for a stricter threshold (`?minCount=`), never a looser one. */
export function effectiveMinReaders(requested: unknown): number {
  const parsed = typeof requested === 'string' ? parseInt(requested, 10) : NaN
  return Number.isFinite(parsed) ? Math.max(MIN_READERS, parsed) : MIN_READERS
}
