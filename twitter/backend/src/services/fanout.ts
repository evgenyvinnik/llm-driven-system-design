import pool from '../db/pool.js';
import redis from '../db/redis.js';
import type { _Pool } from 'pg';
import type Redis from 'ioredis';
import dotenv from 'dotenv';
import logger from '../shared/logger.js';
import { createCircuitBreaker, FANOUT_CIRCUIT_OPTIONS } from '../shared/circuitBreaker.js';
import { withRetry, FANOUT_RETRY_CONFIG } from '../shared/retry.js';
import {
  fanoutOperationsTotal,
  fanoutDuration,
  fanoutFollowersTotal,
  fanoutQueueDepth,
  getFollowerCountBucket,
} from '../shared/metrics.js';

dotenv.config();

const _CELEBRITY_THRESHOLD = parseInt(process.env.CELEBRITY_THRESHOLD || '') || 10000;
const TIMELINE_CACHE_SIZE = parseInt(process.env.TIMELINE_CACHE_SIZE || '') || 800;
const TIMELINE_TTL_SECONDS = parseInt(process.env.TIMELINE_CACHE_TTL_SECONDS || '') || 7 * 24 * 60 * 60;

interface FanoutResult {
  success?: boolean;
  error?: string;
  skipped?: boolean;
  reason?: string;
  followerCount?: number;
  durationMs?: number;
  queued?: boolean;
}

interface RetryQueueItem {
  tweetId: number | string;
  authorId: number | string;
  followers: number[];
  queuedAt?: string;
  retryCount?: number;
  lastRetryAt?: string;
  lastError?: string;
}

async function performRedisFanout(
  tweetId: number | string,
  followers: number[],
  authorId: number | string
): Promise<unknown[]> {
  const pipeline = redis.pipeline();

  for (const followerId of followers) {
    const timelineKey = `timeline:${followerId}`;
    pipeline.lpush(timelineKey, tweetId.toString());
    pipeline.ltrim(timelineKey, 0, TIMELINE_CACHE_SIZE - 1);
    pipeline.expire(timelineKey, TIMELINE_TTL_SECONDS);
  }

  const authorTimelineKey = `timeline:${authorId}`;
  pipeline.lpush(authorTimelineKey, tweetId.toString());
  pipeline.ltrim(authorTimelineKey, 0, TIMELINE_CACHE_SIZE - 1);
  pipeline.expire(authorTimelineKey, TIMELINE_TTL_SECONDS);

  const results = await pipeline.exec();

  if (results) {
    for (const [error] of results) {
      if (error) {
        throw error;
      }
    }
  }

  return results || [];
}

const redisFanoutCircuit = createCircuitBreaker(
  'redis-fanout',
  performRedisFanout as (...args: unknown[]) => Promise<unknown>,
  {
    ...FANOUT_CIRCUIT_OPTIONS,
  },
);

redisFanoutCircuit.fallback(async (tweetId: number | string, followers: number[], authorId: number | string) => {
  logger.warn(
    { tweetId, followerCount: followers.length },
    'Fanout circuit open - queueing for retry',
  );

  try {
    await redis.rpush('fanout:retry_queue', JSON.stringify({
      tweetId,
      authorId,
      followers,
      queuedAt: new Date().toISOString(),
    }));

    const queueLength = await redis.llen('fanout:retry_queue');
    fanoutQueueDepth.set(queueLength);
  } catch (queueError) {
    logger.error(
      { tweetId, authorId, error: (queueError as Error).message },
      'Failed to queue fanout for retry',
    );
  }

  return { queued: true };
});

export async function fanoutTweet(
  tweetId: number | string,
  authorId: number | string
): Promise<FanoutResult> {
  const startTime = Date.now();
  const fanoutLog = logger.child({ tweetId, authorId });

  try {
    const authorResult = await withRetry(
      () => pool.query(
        'SELECT is_celebrity, follower_count FROM users WHERE id = $1',
        [authorId],
      ),
      { ...FANOUT_RETRY_CONFIG, context: `get_author_${authorId}` },
    );

    if (authorResult.rows.length === 0) {
      fanoutLog.error('Author not found for fanout');
      fanoutOperationsTotal.inc({ status: 'error' });
      return { error: 'Author not found' };
    }

    const { is_celebrity: isCelebrity, follower_count: followerCount } = authorResult.rows[0];

    if (isCelebrity) {
      fanoutLog.info(
        { followerCount },
        'Skipping fanout for celebrity user',
      );
      fanoutOperationsTotal.inc({ status: 'skipped' });
      return { skipped: true, reason: 'celebrity', followerCount };
    }

    const followersResult = await withRetry(
      () => pool.query(
        'SELECT follower_id FROM follows WHERE following_id = $1',
        [authorId],
      ),
      { ...FANOUT_RETRY_CONFIG, context: `get_followers_${authorId}` },
    );

    const followers = followersResult.rows.map((r: { follower_id: number }) => r.follower_id);

    if (followers.length === 0) {
      fanoutLog.debug('No followers to fanout to');
      fanoutOperationsTotal.inc({ status: 'success' });
      return { success: true, followerCount: 0 };
    }

    fanoutLog.info(
      { followerCount: followers.length },
      'Starting fanout to followers',
    );

    const result = await redisFanoutCircuit.fire(tweetId, followers, authorId) as { queued?: boolean };

    const duration = (Date.now() - startTime) / 1000;
    const bucket = getFollowerCountBucket(followers.length);

    fanoutDuration.observe({ follower_count_bucket: bucket }, duration);
    fanoutFollowersTotal.inc(followers.length + 1);
    fanoutOperationsTotal.inc({ status: 'success' });

    fanoutLog.info(
      { followerCount: followers.length, durationMs: Date.now() - startTime },
      'Fanout complete',
    );

    return {
      success: true,
      followerCount: followers.length,
      durationMs: Date.now() - startTime,
      queued: result?.queued || false,
    };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;

    fanoutLog.error(
      { error: (error as Error).message, durationMs: Date.now() - startTime },
      'Fanout failed',
    );

    fanoutOperationsTotal.inc({ status: 'error' });
    fanoutDuration.observe({ follower_count_bucket: 'error' }, duration);

    return { error: (error as Error).message };
  }
}

export async function getFollowedCelebrities(userId: number | string): Promise<number[]> {
  const result = await withRetry(
    () => pool.query(
      `SELECT u.id FROM users u
       JOIN follows f ON f.following_id = u.id
       WHERE f.follower_id = $1 AND u.is_celebrity = true`,
      [userId],
    ),
    { ...FANOUT_RETRY_CONFIG, context: `get_celebrities_${userId}` },
  );
  return result.rows.map((r: { id: number }) => r.id);
}

export async function removeTweetFromTimelines(
  tweetId: number | string,
  authorId: number | string
): Promise<{ success?: boolean; affectedTimelines?: number; error?: string }> {
  const removeLog = logger.child({ tweetId, authorId });

  try {
    const followersResult = await withRetry(
      () => pool.query(
        'SELECT follower_id FROM follows WHERE following_id = $1',
        [authorId],
      ),
      { context: `remove_get_followers_${authorId}` },
    );

    const followers = followersResult.rows.map((r: { follower_id: number }) => r.follower_id);

    const pipeline = redis.pipeline();

    for (const followerId of followers) {
      pipeline.lrem(`timeline:${followerId}`, 0, tweetId.toString());
    }

    pipeline.lrem(`timeline:${authorId}`, 0, tweetId.toString());

    await pipeline.exec();

    removeLog.info(
      { followerCount: followers.length },
      'Tweet removed from timelines',
    );

    return { success: true, affectedTimelines: followers.length + 1 };
  } catch (error) {
    removeLog.error(
      { error: (error as Error).message },
      'Failed to remove tweet from timelines',
    );
    return { error: (error as Error).message };
  }
}

export async function processFanoutRetryQueue(
  batchSize = 10
): Promise<{ processed?: number; success?: number; failed?: number; error?: string }> {
  const processLog = logger.child({ operation: 'fanout_retry' });

  try {
    const items: RetryQueueItem[] = [];

    for (let i = 0; i < batchSize; i++) {
      const item = await redis.lpop('fanout:retry_queue');
      if (!item) break;
      items.push(JSON.parse(item));
    }

    if (items.length === 0) {
      return { processed: 0 };
    }

    processLog.info({ count: items.length }, 'Processing fanout retry queue');

    let successCount = 0;
    let failCount = 0;

    for (const item of items) {
      try {
        await performRedisFanout(item.tweetId, item.followers, item.authorId);
        successCount++;
      } catch (error) {
        failCount++;
        await redis.rpush('fanout:retry_queue', JSON.stringify({
          ...item,
          retryCount: (item.retryCount || 0) + 1,
          lastRetryAt: new Date().toISOString(),
          lastError: (error as Error).message,
        }));
      }
    }

    const queueLength = await redis.llen('fanout:retry_queue');
    fanoutQueueDepth.set(queueLength);

    processLog.info(
      { successCount, failCount, queueLength },
      'Fanout retry queue processing complete',
    );

    return { processed: items.length, success: successCount, failed: failCount };
  } catch (error) {
    processLog.error({ error: (error as Error).message }, 'Failed to process retry queue');
    return { error: (error as Error).message };
  }
}

export async function rebuildTimelineCache(
  userId: number | string
): Promise<{ success?: boolean; tweetCount?: number; error?: string }> {
  const rebuildLog = logger.child({ userId, operation: 'timeline_rebuild' });

  try {
    rebuildLog.info('Starting timeline cache rebuild');

    const following = await pool.query(
      `SELECT f.following_id, u.is_celebrity
       FROM follows f
       JOIN users u ON f.following_id = u.id
       WHERE f.follower_id = $1 AND u.is_celebrity = FALSE`,
      [userId],
    );

    const followingIds = following.rows.map((r: { following_id: number }) => r.following_id);

    if (followingIds.length === 0) {
      rebuildLog.info('No non-celebrity follows');
      await redis.del(`timeline:${userId}`);
      return { success: true, tweetCount: 0 };
    }

    const tweets = await pool.query(
      `SELECT id FROM tweets
       WHERE author_id = ANY($1)
         AND is_deleted = FALSE
       ORDER BY created_at DESC
       LIMIT $2`,
      [followingIds, TIMELINE_CACHE_SIZE],
    );

    const tweetIds = tweets.rows.map((t: { id: number }) => t.id.toString());

    if (tweetIds.length === 0) {
      rebuildLog.info('No tweets found from followed users');
      await redis.del(`timeline:${userId}`);
      return { success: true, tweetCount: 0 };
    }

    await redis.del(`timeline:${userId}`);
    await redis.rpush(`timeline:${userId}`, ...tweetIds);
    await redis.expire(`timeline:${userId}`, TIMELINE_TTL_SECONDS);

    rebuildLog.info(
      { tweetCount: tweetIds.length },
      'Timeline cache rebuild complete',
    );

    return { success: true, tweetCount: tweetIds.length };
  } catch (error) {
    rebuildLog.error({ error: (error as Error).message }, 'Timeline rebuild failed');
    return { error: (error as Error).message };
  }
}

export default {
  fanoutTweet,
  getFollowedCelebrities,
  removeTweetFromTimelines,
  processFanoutRetryQueue,
  rebuildTimelineCache,
};
