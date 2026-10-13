/**
 * Redis keys shared by the aggregation API and the aggregation worker
 * @module aggregation/keys
 */

/** Written by the worker after every cycle (epoch ms); /health reports its age. */
export const WORKER_HEARTBEAT_KEY = 'aggregation:worker:heartbeat'

/** Cache key of a book's top passages; the worker deletes it after republishing the book. */
export function popularCacheKey(bookId: string): string {
  return `popular:${bookId}`
}

/** Cache key of a book's heatmap; the worker deletes it after republishing the book. */
export function heatmapCacheKey(bookId: string): string {
  return `heatmap:${bookId}`
}
