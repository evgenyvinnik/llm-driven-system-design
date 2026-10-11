import redis from '../db/redis.js';
import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('submission-status');

/**
 * Redis cache behind the status polling endpoint.
 *
 * Clients poll GET /submissions/:id/status about once a second while a submission is judged,
 * so the hot path reads Redis and only falls back to PostgreSQL (the source of truth) on a miss.
 *
 * Entries only move forward:
 * - the 'pending' entry is written with NX, so a slow API response cannot overwrite progress a
 *   fast worker already published;
 * - progress writes go through a small Lua compare-and-set that refuses to replace a terminal
 *   verdict, so a late write from a worker that lost its lease cannot resurrect "running".
 * Every entry also carries the owner's user id, so the endpoint can check access without a query.
 */
export interface CachedStatus {
  user_id: string;
  status: string;
  terminal: boolean;
  test_cases_passed?: number;
  test_cases_total?: number;
  current_test?: number;
  runtime_ms?: number | null;
  memory_kb?: number | null;
  error_message?: string | null;
}

/** Progress entries outlive a single slow test; if a worker dies they expire and readers use PostgreSQL. */
export const PROGRESS_TTL_SECONDS = 30;
export const VERDICT_TTL_SECONDS = 300;

const SET_UNLESS_TERMINAL = `
local current = redis.call('GET', KEYS[1])
if current and string.find(current, '"terminal":true', 1, true) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

const statusKey = (submissionId: string): string => `submission:${submissionId}:status`;

/** Seeds the cache right after the submission row commits; never overwrites newer state. */
export async function cachePending(submissionId: string, userId: string): Promise<void> {
  const entry: CachedStatus = { user_id: userId, status: 'pending', terminal: false };
  try {
    await redis.set(statusKey(submissionId), JSON.stringify(entry), 'EX', PROGRESS_TTL_SECONDS, 'NX');
  } catch (error) {
    logger.warn({ error: (error as Error).message, submissionId }, 'Failed to cache pending status');
  }
}

/** Publishes "running test N of M"; ignored once a verdict is cached. */
export async function cacheProgress(submissionId: string, entry: Omit<CachedStatus, 'terminal'>): Promise<void> {
  try {
    await redis.eval(
      SET_UNLESS_TERMINAL,
      1,
      statusKey(submissionId),
      JSON.stringify({ ...entry, terminal: false }),
      PROGRESS_TTL_SECONDS
    );
  } catch (error) {
    logger.warn({ error: (error as Error).message, submissionId }, 'Failed to cache progress');
  }
}

/** Caches the final verdict after it is committed to PostgreSQL. */
export async function cacheVerdict(submissionId: string, entry: Omit<CachedStatus, 'terminal'>): Promise<void> {
  try {
    await redis.set(statusKey(submissionId), JSON.stringify({ ...entry, terminal: true }), 'EX', VERDICT_TTL_SECONDS);
  } catch (error) {
    logger.warn({ error: (error as Error).message, submissionId }, 'Failed to cache verdict');
  }
}

/** Reads the cached entry; null on a miss or when Redis is unavailable (callers use PostgreSQL). */
export async function readCachedStatus(submissionId: string): Promise<CachedStatus | null> {
  try {
    const cached = await redis.get(statusKey(submissionId));
    return cached ? (JSON.parse(cached) as CachedStatus) : null;
  } catch (error) {
    logger.warn({ error: (error as Error).message, submissionId }, 'Failed to read cached status');
    return null;
  }
}
