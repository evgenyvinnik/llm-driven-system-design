import pool from '../db/pool.js';
import redis from '../db/redis.js';
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

const CELEBRITY_THRESHOLD = parseInt(process.env.CELEBRITY_THRESHOLD) || 10000;
const TIMELINE_CACHE_SIZE = parseInt(process.env.TIMELINE_CACHE_SIZE) || 800;
const TIMELINE_TTL_SECONDS = parseInt(process.env.TIMELINE_CACHE_TTL_SECONDS) || 7 * 24 * 60 * 60; // 7 days

/**
 * Internal function to perform the actual fanout to Redis
 * This is wrapped by the circuit breaker
 */
async function performRedisFanout(tweetId, followers, authorId) {
  const pipeline = redis.pipeline();

  for (const followerId of followers) {
    const timelineKey = `timeline:${followerId}`;
    // Push tweet ID to the front of the follower's timeline
    pipeline.lpush(timelineKey, tweetId.toString());
    // Trim to keep only the most recent tweets
    pipeline.ltrim(timelineKey, 0, TIMELINE_CACHE_SIZE - 1);
    // Set TTL to prevent stale timelines from persisting
    pipeline.expire(timelineKey, TIMELINE_TTL_SECONDS);
  }

  // Also add to author's own timeline
  const authorTimelineKey = `timeline:${authorId}`;
  pipeline.lpush(authorTimelineKey, tweetId.toString());
  pipeline.ltrim(authorTimelineKey, 0, TIMELINE_CACHE_SIZE - 1);
  pipeline.expire(authorTimelineKey, TIMELINE_TTL_SECONDS);

  const results = await pipeline.exec();

  // Check for errors in pipeline results
  for (const [error, result] of results) {
    if (error) {
      throw error;
    }
  }

  return results;
}

// Create circuit breaker for Redis fanout operations
const redisFanoutCircuit = createCircuitBreaker(
  'redis-fanout',
  performRedisFanout,
  {
    ...FANOUT_CIRCUIT_OPTIONS,
    // Custom fallback: queue for later processing
    errorFilter: (error) => {
      // Don't trip circuit on individual Redis command errors
      // Only trip on connection-level errors
      return error.code === 'ECONNREFUSED' ||
             error.code === 'ECONNRESET' ||
             error.message?.includes('READONLY') ||
             error.message?.includes('CLUSTERDOWN');
    },
  },
);

// Fallback: Store failed fanout in a retry queue
redisFanoutCircuit.fallback(async (tweetId, followers, authorId) => {
  logger.warn(
    { tweetId, followerCount: followers.length },
    'Fanout circuit open - queueing for retry',
  );

  // Store in a Redis list for later retry (even if Redis is having issues,
  // this gives us a chance to recover)
  try {
    await redis.rpush('fanout:retry_queue', JSON.stringify({
      tweetId,
      authorId,
      followers,
      queuedAt: new Date().toISOString(),
    }));

    // Update queue depth metric
    const queueLength = await redis.llen('fanout:retry_queue');
    fanoutQueueDepth.set(queueLength);
  } catch (queueError) {
    // If even the queue fails, log for manual intervention
    logger.error(
      { tweetId, authorId, error: queueError.message },
      'Failed to queue fanout for retry - manual intervention required',
    );
  }

  return { queued: true };
});

/**
 * Fanout a tweet to followers' timelines using hybrid push/pull strategy
 *
 * - For normal users (< CELEBRITY_THRESHOLD followers): Push to all follower timelines
 * - For celebrities: Skip push, will be pulled at read time
 *
 * Uses circuit breaker to protect against Redis failures and retry logic
 * for transient errors.
 *
 * @param {string|number} tweetId - The tweet ID to fanout
 * @param {string|number} authorId - The author's user ID
 * @returns {Promise<object>} Fanout result with stats
 */
export async function fanoutTweet(tweetId, authorId) {
  const startTime = Date.now();
  const fanoutLog = logger.child({ tweetId, authorId });

  try {
    // Check if author is a celebrity
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

    // Skip fanout for celebrities (they will be pulled at read time)
    if (isCelebrity) {
      fanoutLog.info(
        { followerCount },
        'Skipping fanout for celebrity user (will be pulled at read time)',
      );
      fanoutOperationsTotal.inc({ status: 'skipped' });
      return { skipped: true, reason: 'celebrity', followerCount };
    }

    // Get all followers
    const followersResult = await withRetry(
      () => pool.query(
        'SELECT follower_id FROM follows WHERE following_id = $1',
        [authorId],
      ),
      { ...FANOUT_RETRY_CONFIG, context: `get_followers_${authorId}` },
    );

    const followers = followersResult.rows.map((r) => r.follower_id);

    if (followers.length === 0) {
      fanoutLog.debug('No followers to fanout to');
      fanoutOperationsTotal.inc({ status: 'success' });
      return { success: true, followerCount: 0 };
    }

    fanoutLog.info(
      { followerCount: followers.length },
      'Starting fanout to followers',
    );

    // Execute fanout with circuit breaker protection
    const result = await redisFanoutCircuit.fire(tweetId, followers, authorId);

    // Calculate duration and record metrics
    const duration = (Date.now() - startTime) / 1000;
    const bucket = getFollowerCountBucket(followers.length);

    fanoutDuration.observe({ follower_count_bucket: bucket }, duration);
    fanoutFollowersTotal.inc(followers.length + 1); // +1 for author
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
      { error: error.message, durationMs: Date.now() - startTime },
      'Fanout failed',
    );

    fanoutOperationsTotal.inc({ status: 'error' });
    fanoutDuration.observe({ follower_count_bucket: 'error' }, duration);

    // Don't throw - fanout failure shouldn't fail the tweet creation
    return { error: error.message };
  }
}

/**
 * Get list of celebrity users that a user follows
 *
 * @param {string|number} userId - The user ID
 * @returns {Promise<number[]>} Array of celebrity user IDs
 */
export async function getFollowedCelebrities(userId) {
  const result = await withRetry(
    () => pool.query(
      `SELECT u.id FROM users u
       JOIN follows f ON f.following_id = u.id
       WHERE f.follower_id = $1 AND u.is_celebrity = true`,
      [userId],
    ),
    { ...FANOUT_RETRY_CONFIG, context: `get_celebrities_${userId}` },
  );
  return result.rows.map((r) => r.id);
}

/**
 * Remove a tweet from all timelines (for deletion)
 *
 * Note: This is expensive at scale - in production, we'd use lazy deletion
 * where deleted tweets are filtered out at read time instead.
 *
 * @param {string|number} tweetId - The tweet ID to remove
 * @param {string|number} authorId - The author's user ID
 * @returns {Promise<object>} Removal result
 */
export async function removeTweetFromTimelines(tweetId, authorId) {
  const removeLog = logger.child({ tweetId, authorId });

  try {
    // Get all followers
    const followersResult = await withRetry(
      () => pool.query(
        'SELECT follower_id FROM follows WHERE following_id = $1',
        [authorId],
      ),
      { context: `remove_get_followers_${authorId}` },
    );

    const followers = followersResult.rows.map((r) => r.follower_id);

    const pipeline = redis.pipeline();

    for (const followerId of followers) {
      pipeline.lrem(`timeline:${followerId}`, 0, tweetId.toString());
    }

    // Also remove from author's timeline
    pipeline.lrem(`timeline:${authorId}`, 0, tweetId.toString());

    await pipeline.exec();

    removeLog.info(
      { followerCount: followers.length },
      'Tweet removed from timelines',
    );

    return { success: true, affectedTimelines: followers.length + 1 };
  } catch (error) {
    removeLog.error(
      { error: error.message },
      'Failed to remove tweet from timelines',
    );
    return { error: error.message };
  }
}

/**
 * Process the fanout retry queue
 *
 * This should be called periodically by a background worker
 * to retry failed fanout operations.
 *
 * @param {number} batchSize - Number of items to process
 * @returns {Promise<object>} Processing result
 */
export async function processFanoutRetryQueue(batchSize = 10) {
  const processLog = logger.child({ operation: 'fanout_retry' });

  try {
    const items = [];

    // Get items from the retry queue
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
        // Re-queue failed items at the end
        await redis.rpush('fanout:retry_queue', JSON.stringify({
          ...item,
          retryCount: (item.retryCount || 0) + 1,
          lastRetryAt: new Date().toISOString(),
          lastError: error.message,
        }));
      }
    }

    // Update queue depth metric
    const queueLength = await redis.llen('fanout:retry_queue');
    fanoutQueueDepth.set(queueLength);

    processLog.info(
      { successCount, failCount, queueLength },
      'Fanout retry queue processing complete',
    );

    return { processed: items.length, success: successCount, failed: failCount };
  } catch (error) {
    processLog.error({ error: error.message }, 'Failed to process retry queue');
    return { error: error.message };
  }
}

/**
 * Rebuild a user's timeline cache from the database
 *
 * Used for cache recovery after Redis data loss or to fix corrupted timelines.
 *
 * @param {string|number} userId - The user ID
 * @returns {Promise<object>} Rebuild result
 */
export async function rebuildTimelineCache(userId) {
  const rebuildLog = logger.child({ userId, operation: 'timeline_rebuild' });

  try {
    rebuildLog.info('Starting timeline cache rebuild');

    // Get users this person follows (excluding celebrities)
    const following = await pool.query(
      `SELECT f.following_id, u.is_celebrity
       FROM follows f
       JOIN users u ON f.following_id = u.id
       WHERE f.follower_id = $1 AND u.is_celebrity = FALSE`,
      [userId],
    );

    // Get recent tweets from followed users
    const followingIds = following.rows.map((r) => r.following_id);

    if (followingIds.length === 0) {
      rebuildLog.info('No non-celebrity follows - timeline will be empty');
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

    const tweetIds = tweets.rows.map((t) => t.id.toString());

    if (tweetIds.length === 0) {
      rebuildLog.info('No tweets found from followed users');
      await redis.del(`timeline:${userId}`);
      return { success: true, tweetCount: 0 };
    }

    // Rebuild Redis list
    await redis.del(`timeline:${userId}`);
    await redis.rpush(`timeline:${userId}`, ...tweetIds);
    await redis.expire(`timeline:${userId}`, TIMELINE_TTL_SECONDS);

    rebuildLog.info(
      { tweetCount: tweetIds.length },
      'Timeline cache rebuild complete',
    );

    return { success: true, tweetCount: tweetIds.length };
  } catch (error) {
    rebuildLog.error({ error: error.message }, 'Timeline rebuild failed');
    return { error: error.message };
  }
}

export default {
  fanoutTweet,
  getFollowedCelebrities,
  removeTweetFromTimelines,
  processFanoutRetryQueue,
  rebuildTimelineCache,
};
