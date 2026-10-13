/**
 * Precomputed home timelines in Redis sorted sets.
 *
 * Key `timeline:{userId}`: score = post created_at in epoch milliseconds, member = post id.
 * Order is (score DESC, id DESC), which is exactly how ZREVRANGEBYSCORE returns ties, so a
 * cursor of (score, id) pages through the set without OFFSET and without skipping or repeating
 * entries when new posts arrive at the head.
 *
 * A timeline is a cache, not the source of truth. A sentinel member marks it as "built from
 * PostgreSQL"; its score sits above any real timestamp so trimming (which drops the lowest
 * scores) never removes it, and it expires together with the data. Fan-out only writes to
 * timelines that already exist (active users); anyone else is rebuilt on their next read.
 */
import type { Result } from 'ioredis';
import redis from './redis.js';
import config from '../config/index.js';
import logger from './logger.js';

export interface TimelineEntry {
  postId: string;
  /** Post created_at in epoch milliseconds. */
  score: number;
}

export interface FeedCursor {
  ts: number;
  id: string;
}

export interface TimelineRead {
  /** False when the sentinel is missing: the timeline must be rebuilt before it can be trusted. */
  built: boolean;
  /** Number of real entries (sentinel excluded). */
  size: number;
  entries: TimelineEntry[];
}

export const TIMELINE_BUILT_MEMBER = '~built';
export const TIMELINE_BUILT_SCORE = 4_000_000_000_000_000;

/** Entries kept per timeline, plus one slot for the sentinel. */
const keepCount = (): number => config.feed.timelineMaxEntries + 1;

export const timelineKey = (userId: string): string => `timeline:${userId}`;

/**
 * Adds one entry to a timeline only if that timeline is cached, then trims it.
 * Returns 1 when written, 0 when the key did not exist (the owner will rebuild on read).
 */
const ADD_IF_CACHED_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(tonumber(ARGV[3]) + 1))
return 1
`;

redis.defineCommand('timelineAddIfCached', { numberOfKeys: 1, lua: ADD_IF_CACHED_LUA });

declare module 'ioredis' {
  interface RedisCommander<Context> {
    timelineAddIfCached(key: string, score: number, member: string, keep: number): Result<number, Context>;
  }
}

/** True when `entry` sorts strictly after the cursor in (score DESC, id DESC) order. */
export const isAfterCursor = (entry: TimelineEntry, cursor: FeedCursor): boolean =>
  entry.score < cursor.ts || (entry.score === cursor.ts && entry.postId < cursor.id);

const parseWithScores = (flat: string[]): TimelineEntry[] => {
  const entries: TimelineEntry[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (flat[i] === TIMELINE_BUILT_MEMBER) continue;
    entries.push({ postId: flat[i], score: Number(flat[i + 1]) });
  }
  return entries;
};

type PipelineResult = [Error | null, unknown][] | null;

const resultAt = <T>(results: PipelineResult, index: number): T => {
  const pair = results?.[index];
  if (!pair) throw new Error('Redis pipeline returned no result');
  if (pair[0]) throw pair[0];
  return pair[1] as T;
};

/**
 * Reads up to `count` entries strictly after `cursor` (or from the head) in one round trip,
 * together with the built flag and the timeline size.
 */
export async function readTimeline(userId: string, cursor: FeedCursor | null, count: number): Promise<TimelineRead> {
  const key = timelineKey(userId);
  const pipeline = redis.pipeline();
  pipeline.zscore(key, TIMELINE_BUILT_MEMBER);
  pipeline.zcard(key);
  if (cursor) {
    // Entries sharing the cursor's millisecond come back in descending id order; keep those below the cursor id.
    pipeline.zrevrangebyscore(key, cursor.ts, cursor.ts, 'WITHSCORES');
    pipeline.zrevrangebyscore(key, `(${cursor.ts}`, '-inf', 'WITHSCORES', 'LIMIT', 0, count);
  } else {
    pipeline.zrevrangebyscore(key, `(${TIMELINE_BUILT_SCORE}`, '-inf', 'WITHSCORES', 'LIMIT', 0, count);
  }
  const results = await pipeline.exec();

  const built = resultAt<string | null>(results, 0) !== null;
  const cardinality = resultAt<number>(results, 1);
  let entries: TimelineEntry[];
  if (cursor) {
    const ties = parseWithScores(resultAt<string[]>(results, 2)).filter((entry) => isAfterCursor(entry, cursor));
    const older = parseWithScores(resultAt<string[]>(results, 3));
    entries = ties.concat(older).slice(0, count);
  } else {
    entries = parseWithScores(resultAt<string[]>(results, 2));
  }

  return { built, size: Math.max(0, cardinality - (built ? 1 : 0)), entries };
}

export async function isTimelineBuilt(userId: string): Promise<boolean> {
  return (await redis.zscore(timelineKey(userId), TIMELINE_BUILT_MEMBER)) !== null;
}

/**
 * Marks a timeline as built and refreshes its TTL. Called BEFORE the rebuild query runs, so a
 * fan-out that commits while the rebuild is in flight finds the key and lands in it; a fan-out
 * that ran earlier is already visible to the rebuild query.
 */
export async function markTimelineBuilt(userId: string): Promise<void> {
  const key = timelineKey(userId);
  await redis
    .pipeline()
    .zadd(key, TIMELINE_BUILT_SCORE, TIMELINE_BUILT_MEMBER)
    .expire(key, config.feed.timelineTtlSeconds)
    .exec();
}

/** Removes the built marker, e.g. when a rebuild failed half way. */
export async function unmarkTimelineBuilt(userId: string): Promise<void> {
  await redis.zrem(timelineKey(userId), TIMELINE_BUILT_MEMBER);
}

/** Merges entries into a timeline (never deletes), trims it, and refreshes the TTL. */
export async function mergeIntoTimeline(userId: string, entries: TimelineEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const key = timelineKey(userId);
  const pipeline = redis.pipeline();
  const chunkSize = 250;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const args: (string | number)[] = [];
    for (const entry of entries.slice(i, i + chunkSize)) args.push(entry.score, entry.postId);
    pipeline.zadd(key, ...args);
  }
  pipeline.zremrangebyrank(key, 0, -(keepCount() + 1));
  pipeline.expire(key, config.feed.timelineTtlSeconds);
  await pipeline.exec();
}

/** Keeps an active reader's timeline from expiring. */
export async function touchTimeline(userId: string): Promise<void> {
  await redis.expire(timelineKey(userId), config.feed.timelineTtlSeconds);
}

/**
 * Fan-out write: adds one post to many timelines in a single pipeline, skipping timelines that
 * are not cached. Returns how many timelines were actually written.
 */
export async function addToCachedTimelines(userIds: string[], entry: TimelineEntry): Promise<number> {
  if (userIds.length === 0) return 0;
  const pipeline = redis.pipeline();
  for (const userId of userIds) {
    pipeline.timelineAddIfCached(timelineKey(userId), entry.score, entry.postId, keepCount());
  }
  const results = (await pipeline.exec()) || [];
  let written = 0;
  for (const [error, value] of results) {
    if (error) {
      logger.warn({ error: error.message, postId: entry.postId }, 'Timeline fan-out write failed');
    } else if (value === 1) {
      written += 1;
    }
  }
  return written;
}

/** Removes posts from many timelines in a single pipeline (missing keys are no-ops). */
export async function removeFromTimelines(userIds: string[], postIds: string[]): Promise<void> {
  if (userIds.length === 0 || postIds.length === 0) return;
  const pipeline = redis.pipeline();
  for (const userId of userIds) pipeline.zrem(timelineKey(userId), ...postIds);
  await pipeline.exec();
}
