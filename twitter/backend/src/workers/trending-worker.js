/**
 * Trending Worker
 *
 * Consumes tweet and like events from Kafka to update trending hashtag counts in Redis.
 * Uses sorted sets for efficient ranking of trending hashtags.
 *
 * Trending algorithm:
 * - Track hashtags in time-bucketed counters (1-minute buckets)
 * - Maintain a sorted set of hashtags with their scores
 * - Likes on tweets boost their hashtags' trending scores
 *
 * Usage:
 *   npm run dev:trending-worker
 *   node src/workers/trending-worker.js
 */

import dotenv from 'dotenv';
dotenv.config();

import pool from '../db/pool.js';
import redis from '../db/redis.js';
import logger from '../shared/logger.js';
import { consumeMultiple, TOPICS } from '../shared/kafka.js';

const TREND_BUCKET_TTL = parseInt(process.env.TREND_BUCKET_TTL_SECONDS) || 7200; // 2 hours
const BUCKET_SIZE = 60; // 1 minute in seconds
const CONSUMER_GROUP = process.env.TRENDING_CONSUMER_GROUP || 'trending-workers';

// Keys for Redis sorted sets
const TRENDING_HOURLY_KEY = 'trending:hourly';
const TRENDING_DAILY_KEY = 'trending:daily';

const workerLog = logger.child({ worker: 'trending' });

let consumer = null;
let isShuttingDown = false;

/**
 * Get the current time bucket (1-minute granularity)
 */
function getCurrentBucket() {
  return Math.floor(Date.now() / 1000 / BUCKET_SIZE);
}

/**
 * Process a tweet event: extract hashtags and update trending counts
 * @param {object} message - Tweet event from Kafka
 */
async function handleTweetEvent(message) {
  const { tweetId, hashtags, type } = message;

  if (type !== 'tweet_created') {
    return;
  }

  if (!hashtags || hashtags.length === 0) {
    workerLog.debug({ tweetId }, 'No hashtags in tweet, skipping');
    return;
  }

  const bucket = getCurrentBucket();
  const eventLog = workerLog.child({ tweetId, hashtagCount: hashtags.length });

  try {
    const pipeline = redis.pipeline();

    for (const hashtag of hashtags) {
      const tag = hashtag.toLowerCase();

      // Increment time-bucketed counter for trend scoring
      const bucketKey = `trend:${tag}:${bucket}`;
      pipeline.incr(bucketKey);
      pipeline.expire(bucketKey, TREND_BUCKET_TTL);

      // Update sorted sets for quick trending queries
      // Score by count (atomic increment)
      pipeline.zincrby(TRENDING_HOURLY_KEY, 1, tag);
      pipeline.zincrby(TRENDING_DAILY_KEY, 1, tag);
    }

    await pipeline.exec();

    eventLog.debug({ hashtags }, 'Updated trending counts for hashtags');
  } catch (error) {
    eventLog.error({ error: error.message }, 'Failed to update trending counts');
  }
}

/**
 * Process a like event: boost hashtags from the liked tweet
 * @param {object} message - Like event from Kafka
 */
async function handleLikeEvent(message) {
  const { tweetId, userId, type } = message;

  if (type !== 'tweet_liked') {
    return;
  }

  const eventLog = workerLog.child({ tweetId, userId });

  try {
    // Get the tweet's hashtags from the database
    const result = await pool.query(
      'SELECT hashtags FROM tweets WHERE id = $1',
      [tweetId],
    );

    if (result.rows.length === 0) {
      eventLog.debug('Tweet not found for like event');
      return;
    }

    const hashtags = result.rows[0].hashtags;

    if (!hashtags || hashtags.length === 0) {
      return;
    }

    const bucket = getCurrentBucket();
    const pipeline = redis.pipeline();

    // Likes give a smaller boost than direct usage (0.3 weight)
    const likeWeight = 0.3;

    for (const hashtag of hashtags) {
      const tag = hashtag.toLowerCase();

      // Increment time-bucketed counter with like weight
      const bucketKey = `trend:${tag}:${bucket}`;
      pipeline.incrbyfloat(bucketKey, likeWeight);
      pipeline.expire(bucketKey, TREND_BUCKET_TTL);

      // Update sorted sets
      pipeline.zincrby(TRENDING_HOURLY_KEY, likeWeight, tag);
      pipeline.zincrby(TRENDING_DAILY_KEY, likeWeight, tag);
    }

    await pipeline.exec();

    eventLog.debug({ hashtags, weight: likeWeight }, 'Boosted trending counts for liked hashtags');
  } catch (error) {
    eventLog.error({ error: error.message }, 'Failed to boost trending counts for like');
  }
}

/**
 * Unified message handler that routes to the appropriate handler
 */
async function handleMessage(message, topic) {
  if (topic === TOPICS.TWEETS) {
    await handleTweetEvent(message);
  } else if (topic === TOPICS.LIKES) {
    await handleLikeEvent(message);
  } else {
    workerLog.debug({ topic }, 'Unknown topic, ignoring');
  }
}

/**
 * Periodically clean up old entries from sorted sets
 * Removes hashtags with low scores to prevent unbounded growth
 */
async function cleanupSortedSets() {
  try {
    // Remove hashtags with score < 1 from hourly
    await redis.zremrangebyscore(TRENDING_HOURLY_KEY, '-inf', 0.5);

    // Remove hashtags with score < 5 from daily
    await redis.zremrangebyscore(TRENDING_DAILY_KEY, '-inf', 4.5);

    // Also apply exponential decay to hourly scores (decay by 10%)
    const hourlyTags = await redis.zrange(TRENDING_HOURLY_KEY, 0, -1, 'WITHSCORES');
    if (hourlyTags.length > 0) {
      const pipeline = redis.pipeline();
      for (let i = 0; i < hourlyTags.length; i += 2) {
        const tag = hourlyTags[i];
        const score = parseFloat(hourlyTags[i + 1]);
        const decayedScore = score * 0.9;
        pipeline.zadd(TRENDING_HOURLY_KEY, decayedScore, tag);
      }
      await pipeline.exec();
    }

    workerLog.debug('Sorted set cleanup complete');
  } catch (error) {
    workerLog.error({ error: error.message }, 'Sorted set cleanup failed');
  }
}

/**
 * Start the trending worker
 */
async function start() {
  workerLog.info('Starting trending worker...');

  try {
    // Create consumer and start processing both tweets and likes topics
    consumer = await consumeMultiple(handleMessage, CONSUMER_GROUP, [TOPICS.TWEETS, TOPICS.LIKES]);
    await consumer.run();

    // Start periodic cleanup (every 5 minutes)
    setInterval(cleanupSortedSets, 5 * 60 * 1000);

    workerLog.info({ consumerGroup: CONSUMER_GROUP }, 'Trending worker running');
  } catch (error) {
    workerLog.error({ error: error.message }, 'Failed to start trending worker');
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  workerLog.info({ signal }, 'Shutting down trending worker...');

  try {
    if (consumer) {
      await consumer.disconnect();
    }

    await pool.end();
    await redis.quit();

    workerLog.info('Trending worker shutdown complete');
    process.exit(0);
  } catch (error) {
    workerLog.error({ error: error.message }, 'Error during shutdown');
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  workerLog.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  workerLog.error({ reason }, 'Unhandled promise rejection');
});

// Start the worker
start().catch((error) => {
  workerLog.fatal({ error: error.message }, 'Failed to start worker');
  process.exit(1);
});
