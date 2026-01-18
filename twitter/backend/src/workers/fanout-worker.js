/**
 * Fanout Worker
 *
 * Consumes tweet events from Kafka and fans out to followers' cached timelines in Redis.
 * This enables async fanout without blocking the tweet creation API response.
 *
 * Usage:
 *   npm run dev:fanout-worker
 *   node src/workers/fanout-worker.js
 */

import dotenv from 'dotenv';
dotenv.config();

import pool from '../db/pool.js';
import redis from '../db/redis.js';
import logger from '../shared/logger.js';
import { consumeTweets } from '../shared/kafka.js';

const CELEBRITY_THRESHOLD = parseInt(process.env.CELEBRITY_THRESHOLD) || 10000;
const TIMELINE_CACHE_SIZE = parseInt(process.env.TIMELINE_CACHE_SIZE) || 800;
const TIMELINE_TTL_SECONDS = parseInt(process.env.TIMELINE_CACHE_TTL_SECONDS) || 7 * 24 * 60 * 60; // 7 days
const CONSUMER_GROUP = process.env.FANOUT_CONSUMER_GROUP || 'fanout-workers';

const workerLog = logger.child({ worker: 'fanout' });

let consumer = null;
let isShuttingDown = false;

/**
 * Process a tweet event: find followers and update their cached timelines
 * @param {object} message - Tweet event from Kafka
 */
async function handleTweetEvent(message, topic, partition) {
  const { tweetId, authorId, type } = message;

  if (type !== 'tweet_created') {
    workerLog.debug({ type, tweetId }, 'Ignoring non-tweet-created event');
    return;
  }

  const eventLog = workerLog.child({ tweetId, authorId, partition });
  const startTime = Date.now();

  try {
    // Check if author is a celebrity - skip fanout for celebrities
    const authorResult = await pool.query(
      'SELECT is_celebrity, follower_count FROM users WHERE id = $1',
      [authorId],
    );

    if (authorResult.rows.length === 0) {
      eventLog.warn('Author not found, skipping fanout');
      return;
    }

    const { is_celebrity: isCelebrity, follower_count: followerCount } = authorResult.rows[0];

    if (isCelebrity) {
      eventLog.info({ followerCount }, 'Skipping fanout for celebrity (will be pulled at read time)');
      return;
    }

    // Get all followers
    const followersResult = await pool.query(
      'SELECT follower_id FROM follows WHERE following_id = $1',
      [authorId],
    );

    const followers = followersResult.rows.map((r) => r.follower_id);

    if (followers.length === 0) {
      eventLog.debug('No followers, adding tweet to author timeline only');
    }

    // Use Redis pipeline for efficient bulk updates
    const pipeline = redis.pipeline();

    // Push to each follower's timeline
    for (const followerId of followers) {
      const timelineKey = `timeline:${followerId}`;
      pipeline.lpush(timelineKey, tweetId);
      pipeline.ltrim(timelineKey, 0, TIMELINE_CACHE_SIZE - 1);
      pipeline.expire(timelineKey, TIMELINE_TTL_SECONDS);
    }

    // Also add to author's own timeline
    const authorTimelineKey = `timeline:${authorId}`;
    pipeline.lpush(authorTimelineKey, tweetId);
    pipeline.ltrim(authorTimelineKey, 0, TIMELINE_CACHE_SIZE - 1);
    pipeline.expire(authorTimelineKey, TIMELINE_TTL_SECONDS);

    const results = await pipeline.exec();

    // Check for errors in pipeline results
    let errorCount = 0;
    for (const [error] of results) {
      if (error) {
        errorCount++;
        eventLog.error({ error: error.message }, 'Redis pipeline error');
      }
    }

    const duration = Date.now() - startTime;
    eventLog.info({
      followerCount: followers.length,
      durationMs: duration,
      errors: errorCount,
    }, 'Fanout complete');
  } catch (error) {
    eventLog.error({ error: error.message, stack: error.stack }, 'Fanout failed');
    // Don't throw - we don't want to crash the worker
  }
}

/**
 * Start the fanout worker
 */
async function start() {
  workerLog.info('Starting fanout worker...');

  try {
    // Create consumer and start processing
    consumer = await consumeTweets(handleTweetEvent, CONSUMER_GROUP);
    await consumer.run();

    workerLog.info({ consumerGroup: CONSUMER_GROUP }, 'Fanout worker running');
  } catch (error) {
    workerLog.error({ error: error.message }, 'Failed to start fanout worker');
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

  workerLog.info({ signal }, 'Shutting down fanout worker...');

  try {
    if (consumer) {
      await consumer.disconnect();
    }

    await pool.end();
    await redis.quit();

    workerLog.info('Fanout worker shutdown complete');
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
