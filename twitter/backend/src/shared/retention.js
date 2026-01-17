import logger from './logger.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Data Retention and Archival Configuration
 *
 * Defines policies for data lifecycle management:
 * - How long data is kept in hot storage
 * - When data is archived to cold storage
 * - When data is permanently deleted
 *
 * These policies balance:
 * - Storage costs (keep less data = lower costs)
 * - User experience (keep more data = better experience)
 * - Compliance requirements (some data must be kept/deleted)
 */

/**
 * Retention Policies
 *
 * All durations are in seconds unless otherwise specified
 */
export const RETENTION_POLICIES = {
  /**
   * Tweet Retention
   */
  tweets: {
    // Soft-deleted tweets are kept for this long before hard delete
    softDeleteRetentionDays: parseInt(process.env.TWEET_SOFT_DELETE_RETENTION_DAYS) || 30,

    // Active tweets are never auto-deleted (user must delete)
    autoDeleteEnabled: false,

    // Archive tweets older than this (0 = disabled)
    archiveAfterDays: parseInt(process.env.TWEET_ARCHIVE_AFTER_DAYS) || 0,
  },

  /**
   * Timeline Cache Retention (Redis)
   */
  timelineCache: {
    // TTL for timeline entries in Redis
    ttlSeconds: parseInt(process.env.TIMELINE_CACHE_TTL_SECONDS) || 7 * 24 * 60 * 60, // 7 days

    // Maximum tweets per timeline
    maxSize: parseInt(process.env.TIMELINE_CACHE_SIZE) || 800,
  },

  /**
   * Trend Bucket Retention (Redis)
   */
  trendBuckets: {
    // TTL for trend counting buckets
    ttlSeconds: parseInt(process.env.TREND_BUCKET_TTL_SECONDS) || 2 * 60 * 60, // 2 hours

    // Size of each bucket in seconds
    bucketSizeSeconds: 60, // 1 minute

    // Number of buckets in the trend window
    windowBuckets: 60, // 60 minutes
  },

  /**
   * Session Retention (Redis)
   */
  sessions: {
    // TTL for user sessions
    ttlSeconds: parseInt(process.env.SESSION_TTL_SECONDS) || 7 * 24 * 60 * 60, // 7 days
  },

  /**
   * Idempotency Key Retention (Redis)
   */
  idempotencyKeys: {
    // TTL for idempotency keys
    ttlSeconds: parseInt(process.env.IDEMPOTENCY_TTL_SECONDS) || 24 * 60 * 60, // 24 hours
  },

  /**
   * Hashtag Activity Retention (PostgreSQL)
   */
  hashtagActivity: {
    // Keep detailed hashtag activity for this long
    retentionDays: parseInt(process.env.HASHTAG_ACTIVITY_RETENTION_DAYS) || 90,

    // Aggregate older data into daily summaries
    aggregateAfterDays: parseInt(process.env.HASHTAG_AGGREGATE_AFTER_DAYS) || 7,
  },

  /**
   * User Activity Logs
   */
  activityLogs: {
    // Keep user activity logs for compliance
    retentionDays: parseInt(process.env.ACTIVITY_LOG_RETENTION_DAYS) || 365,
  },
};

/**
 * Archival Configuration
 *
 * Settings for moving old data to cold storage
 */
export const ARCHIVAL_CONFIG = {
  // Enable/disable archival
  enabled: process.env.ARCHIVAL_ENABLED === 'true',

  // S3/MinIO bucket for archives
  bucket: process.env.ARCHIVE_BUCKET || 'twitter-archives',

  // Prefix for archive objects
  prefix: process.env.ARCHIVE_PREFIX || 'archives/',

  // Format for archived data
  format: 'jsonl', // JSON Lines format

  // Compression
  compression: 'gzip',

  // Batch size for archival jobs
  batchSize: parseInt(process.env.ARCHIVE_BATCH_SIZE) || 10000,
};

/**
 * Cleanup Job Configuration
 */
export const CLEANUP_CONFIG = {
  // How often to run cleanup jobs (in hours)
  intervalHours: parseInt(process.env.CLEANUP_INTERVAL_HOURS) || 24,

  // Batch size for cleanup operations
  batchSize: parseInt(process.env.CLEANUP_BATCH_SIZE) || 1000,

  // Maximum duration for cleanup job (to prevent long-running transactions)
  maxDurationSeconds: parseInt(process.env.CLEANUP_MAX_DURATION_SECONDS) || 300, // 5 minutes
};

/**
 * SQL queries for retention cleanup
 */
export const CLEANUP_QUERIES = {
  /**
   * Hard delete soft-deleted tweets older than retention period
   */
  deleteSoftDeletedTweets: `
    WITH deleted_tweets AS (
      SELECT id FROM tweets
      WHERE is_deleted = true
        AND created_at < NOW() - INTERVAL '${RETENTION_POLICIES.tweets.softDeleteRetentionDays} days'
      LIMIT $1
    )
    DELETE FROM tweets
    WHERE id IN (SELECT id FROM deleted_tweets)
    RETURNING id
  `,

  /**
   * Clean up old hashtag activity
   */
  cleanupHashtagActivity: `
    DELETE FROM hashtag_activity
    WHERE created_at < NOW() - INTERVAL '${RETENTION_POLICIES.hashtagActivity.retentionDays} days'
    LIMIT $1
  `,

  /**
   * Get tweets for archival
   */
  getTweetsForArchival: `
    SELECT t.*, u.username
    FROM tweets t
    JOIN users u ON t.author_id = u.id
    WHERE t.created_at < NOW() - INTERVAL '${RETENTION_POLICIES.tweets.archiveAfterDays} days'
      AND t.archived_at IS NULL
    ORDER BY t.created_at
    LIMIT $1
  `,

  /**
   * Mark tweets as archived
   */
  markTweetsArchived: `
    UPDATE tweets
    SET archived_at = NOW(),
        archive_location = $2
    WHERE id = ANY($1)
  `,
};

/**
 * Redis cleanup functions
 */
export const redisCleanup = {
  /**
   * Get Redis key patterns for cleanup
   */
  getExpiredKeyPatterns() {
    return [
      'idempotency:*',
      'trend:*',
    ];
  },

  /**
   * Set TTL on timeline keys that might be missing TTL
   * @param {object} redis - Redis client
   */
  async ensureTimelineTtl(redis) {
    const cursor = '0';
    const pattern = 'timeline:*';
    const ttl = RETENTION_POLICIES.timelineCache.ttlSeconds;

    let scanCursor = cursor;
    let totalFixed = 0;

    do {
      const [nextCursor, keys] = await redis.scan(scanCursor, 'MATCH', pattern, 'COUNT', 100);
      scanCursor = nextCursor;

      for (const key of keys) {
        const currentTtl = await redis.ttl(key);
        if (currentTtl === -1) {
          // Key has no TTL, set one
          await redis.expire(key, ttl);
          totalFixed++;
        }
      }
    } while (scanCursor !== '0');

    logger.info({ totalFixed }, 'Fixed timeline keys missing TTL');
    return totalFixed;
  },
};

/**
 * Validate that retention configuration is sensible
 */
export function validateRetentionConfig() {
  const issues = [];

  // Soft delete retention should be at least 7 days for user recovery
  if (RETENTION_POLICIES.tweets.softDeleteRetentionDays < 7) {
    issues.push('Tweet soft delete retention should be at least 7 days');
  }

  // Timeline cache should be at least 1 day
  if (RETENTION_POLICIES.timelineCache.ttlSeconds < 86400) {
    issues.push('Timeline cache TTL should be at least 1 day');
  }

  // Idempotency keys should be at least 1 hour
  if (RETENTION_POLICIES.idempotencyKeys.ttlSeconds < 3600) {
    issues.push('Idempotency TTL should be at least 1 hour');
  }

  if (issues.length > 0) {
    logger.warn({ issues }, 'Retention configuration has potential issues');
  } else {
    logger.info('Retention configuration validated successfully');
  }

  return issues;
}

/**
 * Log current retention configuration at startup
 */
export function logRetentionConfig() {
  logger.info(
    {
      tweetSoftDeleteDays: RETENTION_POLICIES.tweets.softDeleteRetentionDays,
      timelineCacheTtlDays: Math.round(RETENTION_POLICIES.timelineCache.ttlSeconds / 86400),
      idempotencyTtlHours: Math.round(RETENTION_POLICIES.idempotencyKeys.ttlSeconds / 3600),
      hashtagActivityRetentionDays: RETENTION_POLICIES.hashtagActivity.retentionDays,
      archivalEnabled: ARCHIVAL_CONFIG.enabled,
    },
    'Data retention configuration loaded',
  );
}

export default {
  RETENTION_POLICIES,
  ARCHIVAL_CONFIG,
  CLEANUP_CONFIG,
  CLEANUP_QUERIES,
  redisCleanup,
  validateRetentionConfig,
  logRetentionConfig,
};
