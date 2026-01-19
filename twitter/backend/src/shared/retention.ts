import type Redis from 'ioredis';
import logger from './logger.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Data Retention and Archival Configuration
 */

interface TweetRetentionPolicy {
  softDeleteRetentionDays: number;
  autoDeleteEnabled: boolean;
  archiveAfterDays: number;
}

interface TimelineCachePolicy {
  ttlSeconds: number;
  maxSize: number;
}

interface TrendBucketsPolicy {
  ttlSeconds: number;
  bucketSizeSeconds: number;
  windowBuckets: number;
}

interface SessionsPolicy {
  ttlSeconds: number;
}

interface IdempotencyKeysPolicy {
  ttlSeconds: number;
}

interface HashtagActivityPolicy {
  retentionDays: number;
  aggregateAfterDays: number;
}

interface ActivityLogsPolicy {
  retentionDays: number;
}

interface RetentionPolicies {
  tweets: TweetRetentionPolicy;
  timelineCache: TimelineCachePolicy;
  trendBuckets: TrendBucketsPolicy;
  sessions: SessionsPolicy;
  idempotencyKeys: IdempotencyKeysPolicy;
  hashtagActivity: HashtagActivityPolicy;
  activityLogs: ActivityLogsPolicy;
}

export const RETENTION_POLICIES: RetentionPolicies = {
  tweets: {
    softDeleteRetentionDays: parseInt(process.env.TWEET_SOFT_DELETE_RETENTION_DAYS || '') || 30,
    autoDeleteEnabled: false,
    archiveAfterDays: parseInt(process.env.TWEET_ARCHIVE_AFTER_DAYS || '') || 0,
  },

  timelineCache: {
    ttlSeconds: parseInt(process.env.TIMELINE_CACHE_TTL_SECONDS || '') || 7 * 24 * 60 * 60, // 7 days
    maxSize: parseInt(process.env.TIMELINE_CACHE_SIZE || '') || 800,
  },

  trendBuckets: {
    ttlSeconds: parseInt(process.env.TREND_BUCKET_TTL_SECONDS || '') || 2 * 60 * 60, // 2 hours
    bucketSizeSeconds: 60, // 1 minute
    windowBuckets: 60, // 60 minutes
  },

  sessions: {
    ttlSeconds: parseInt(process.env.SESSION_TTL_SECONDS || '') || 7 * 24 * 60 * 60, // 7 days
  },

  idempotencyKeys: {
    ttlSeconds: parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '') || 24 * 60 * 60, // 24 hours
  },

  hashtagActivity: {
    retentionDays: parseInt(process.env.HASHTAG_ACTIVITY_RETENTION_DAYS || '') || 90,
    aggregateAfterDays: parseInt(process.env.HASHTAG_AGGREGATE_AFTER_DAYS || '') || 7,
  },

  activityLogs: {
    retentionDays: parseInt(process.env.ACTIVITY_LOG_RETENTION_DAYS || '') || 365,
  },
};

/**
 * Archival Configuration
 */
interface ArchivalConfig {
  enabled: boolean;
  bucket: string;
  prefix: string;
  format: string;
  compression: string;
  batchSize: number;
}

export const ARCHIVAL_CONFIG: ArchivalConfig = {
  enabled: process.env.ARCHIVAL_ENABLED === 'true',
  bucket: process.env.ARCHIVE_BUCKET || 'twitter-archives',
  prefix: process.env.ARCHIVE_PREFIX || 'archives/',
  format: 'jsonl',
  compression: 'gzip',
  batchSize: parseInt(process.env.ARCHIVE_BATCH_SIZE || '') || 10000,
};

/**
 * Cleanup Job Configuration
 */
interface CleanupConfig {
  intervalHours: number;
  batchSize: number;
  maxDurationSeconds: number;
}

export const CLEANUP_CONFIG: CleanupConfig = {
  intervalHours: parseInt(process.env.CLEANUP_INTERVAL_HOURS || '') || 24,
  batchSize: parseInt(process.env.CLEANUP_BATCH_SIZE || '') || 1000,
  maxDurationSeconds: parseInt(process.env.CLEANUP_MAX_DURATION_SECONDS || '') || 300, // 5 minutes
};

/**
 * SQL queries for retention cleanup
 */
export const CLEANUP_QUERIES = {
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

  cleanupHashtagActivity: `
    DELETE FROM hashtag_activity
    WHERE created_at < NOW() - INTERVAL '${RETENTION_POLICIES.hashtagActivity.retentionDays} days'
    LIMIT $1
  `,

  getTweetsForArchival: `
    SELECT t.*, u.username
    FROM tweets t
    JOIN users u ON t.author_id = u.id
    WHERE t.created_at < NOW() - INTERVAL '${RETENTION_POLICIES.tweets.archiveAfterDays} days'
      AND t.archived_at IS NULL
    ORDER BY t.created_at
    LIMIT $1
  `,

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
  getExpiredKeyPatterns(): string[] {
    return [
      'idempotency:*',
      'trend:*',
    ];
  },

  async ensureTimelineTtl(redis: Redis): Promise<number> {
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
export function validateRetentionConfig(): string[] {
  const issues: string[] = [];

  if (RETENTION_POLICIES.tweets.softDeleteRetentionDays < 7) {
    issues.push('Tweet soft delete retention should be at least 7 days');
  }

  if (RETENTION_POLICIES.timelineCache.ttlSeconds < 86400) {
    issues.push('Timeline cache TTL should be at least 1 day');
  }

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
export function logRetentionConfig(): void {
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
