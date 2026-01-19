import { db } from '../config/database.js';
import { logger } from './logger.js';

/**
 * Data retention and archival configuration.
 *
 * WHY: Data lifecycle policies are essential for:
 * - Compliance: HIPAA requires defined retention periods and secure deletion
 * - Cost optimization: Storage tiering reduces long-term costs
 * - Performance: Smaller active datasets improve query speed
 * - Privacy: Automatic deletion reduces data exposure risk
 *
 * Storage tiers:
 * - Hot: Recent data, uncompressed, fast access (TimescaleDB)
 * - Warm: Older data, compressed, slower access (TimescaleDB compressed chunks)
 * - Cold: Archived data, Parquet files in object storage (MinIO)
 */

interface RetentionPeriod {
  hot: number | null;
  warm?: number;
  delete: number | null;
}

interface ShareTokensRetention {
  afterExpiry: number;
}

interface SessionsRetention {
  ttlSeconds: number;
  delete: number;
}

interface RetentionConfig {
  samples: Required<RetentionPeriod>;
  hourlyAggregates: { hot: number; delete: number };
  dailyAggregates: RetentionPeriod;
  insights: { hot: number; delete: number };
  shareTokens: ShareTokensRetention;
  sessions: SessionsRetention;
  auditLogs: Required<RetentionPeriod>;
}

interface CacheTTLItem {
  ttlSeconds: number;
  prefix: string;
}

interface CacheTTLConfig {
  session: CacheTTLItem;
  aggregates: CacheTTLItem;
  latestMetrics: CacheTTLItem;
  insights: CacheTTLItem;
  idempotency: CacheTTLItem;
}

interface RetentionError {
  operation: string;
  error: string;
}

interface RetentionCleanupResults {
  samplesDeleted: number;
  aggregatesDeleted: number;
  insightsDeleted: number;
  tokensDeleted: number;
  sessionsDeleted: number;
  errors: RetentionError[];
}

interface CompressionResult {
  samplesChunks?: number | null;
  aggregatesChunks?: number | null;
  skipped?: boolean;
  reason?: string;
}

interface RetentionStatusResult {
  hot_samples: string;
  warm_samples: string;
  oldest_sample: Date | null;
  newest_sample: Date | null;
}

/**
 * Retention policy configuration.
 * All durations in days.
 */
export const retentionConfig: RetentionConfig = {
  // Raw health samples
  samples: {
    hot: 90,           // Uncompressed, fast access
    warm: 730,         // Compressed (2 years)
    delete: 2555       // Delete after 7 years (HIPAA minimum)
  },

  // Hourly aggregates
  hourlyAggregates: {
    hot: 90,
    delete: 730        // 2 years - not needed long-term
  },

  // Daily aggregates
  dailyAggregates: {
    hot: null,         // Never compress - always needed for dashboards
    delete: null       // Never delete - summary data is small
  },

  // Insights
  insights: {
    hot: 90,
    delete: 730        // 2 years
  },

  // Share tokens
  shareTokens: {
    afterExpiry: 30    // Delete 30 days after expiration
  },

  // Sessions
  sessions: {
    ttlSeconds: 86400 * 7,  // 7 days
    delete: 7               // Cleanup expired after 7 days
  },

  // Audit logs (when implemented)
  auditLogs: {
    hot: 365,
    warm: 2190,        // 6 years
    delete: 2555       // 7 years (HIPAA)
  }
};

/**
 * Cache TTL configuration.
 * Balances freshness vs. database load.
 */
export const cacheTTLConfig: CacheTTLConfig = {
  // User session
  session: {
    ttlSeconds: 86400,      // 24 hours
    prefix: 'session:'
  },

  // Aggregated data for dashboards
  aggregates: {
    ttlSeconds: 3600,       // 1 hour - invalidated on sync
    prefix: 'agg:'
  },

  // Latest metrics
  latestMetrics: {
    ttlSeconds: 300,        // 5 minutes
    prefix: 'latest:'
  },

  // Insights
  insights: {
    ttlSeconds: 300,        // 5 minutes
    prefix: 'insight:'
  },

  // Idempotency keys
  idempotency: {
    ttlSeconds: 86400,      // 24 hours
    prefix: 'idem:'
  }
};

/**
 * Execute data retention cleanup.
 * Should be run as a scheduled job (daily).
 */
export async function runRetentionCleanup(): Promise<RetentionCleanupResults> {
  const results: RetentionCleanupResults = {
    samplesDeleted: 0,
    aggregatesDeleted: 0,
    insightsDeleted: 0,
    tokensDeleted: 0,
    sessionsDeleted: 0,
    errors: []
  };

  logger.info({ msg: 'Starting retention cleanup' });

  // Delete old samples (beyond retention period)
  try {
    const samplesResult = await db.query(`
      DELETE FROM health_samples
      WHERE start_date < NOW() - INTERVAL '${retentionConfig.samples.delete} days'
      RETURNING id
    `);
    results.samplesDeleted = samplesResult.rowCount || 0;
    logger.info({
      msg: 'Deleted expired samples',
      count: results.samplesDeleted
    });
  } catch (error) {
    results.errors.push({ operation: 'samples', error: (error as Error).message });
    logger.error({ msg: 'Failed to delete samples', error: (error as Error).message });
  }

  // Delete old hourly aggregates
  try {
    const aggResult = await db.query(`
      DELETE FROM health_aggregates
      WHERE period = 'hour'
        AND period_start < NOW() - INTERVAL '${retentionConfig.hourlyAggregates.delete} days'
      RETURNING id
    `);
    results.aggregatesDeleted = aggResult.rowCount || 0;
    logger.info({
      msg: 'Deleted expired hourly aggregates',
      count: results.aggregatesDeleted
    });
  } catch (error) {
    results.errors.push({ operation: 'aggregates', error: (error as Error).message });
    logger.error({ msg: 'Failed to delete aggregates', error: (error as Error).message });
  }

  // Delete old insights
  try {
    const insightsResult = await db.query(`
      DELETE FROM health_insights
      WHERE created_at < NOW() - INTERVAL '${retentionConfig.insights.delete} days'
      RETURNING id
    `);
    results.insightsDeleted = insightsResult.rowCount || 0;
    logger.info({
      msg: 'Deleted expired insights',
      count: results.insightsDeleted
    });
  } catch (error) {
    results.errors.push({ operation: 'insights', error: (error as Error).message });
    logger.error({ msg: 'Failed to delete insights', error: (error as Error).message });
  }

  // Delete expired share tokens
  try {
    const tokensResult = await db.query(`
      DELETE FROM share_tokens
      WHERE expires_at < NOW() - INTERVAL '${retentionConfig.shareTokens.afterExpiry} days'
      RETURNING id
    `);
    results.tokensDeleted = tokensResult.rowCount || 0;
    logger.info({
      msg: 'Deleted expired share tokens',
      count: results.tokensDeleted
    });
  } catch (error) {
    results.errors.push({ operation: 'tokens', error: (error as Error).message });
    logger.error({ msg: 'Failed to delete share tokens', error: (error as Error).message });
  }

  // Delete expired sessions
  try {
    const sessionsResult = await db.query(`
      DELETE FROM sessions
      WHERE expires_at < NOW() - INTERVAL '${retentionConfig.sessions.delete} days'
      RETURNING id
    `);
    results.sessionsDeleted = sessionsResult.rowCount || 0;
    logger.info({
      msg: 'Deleted expired sessions',
      count: results.sessionsDeleted
    });
  } catch (error) {
    results.errors.push({ operation: 'sessions', error: (error as Error).message });
    logger.error({ msg: 'Failed to delete sessions', error: (error as Error).message });
  }

  logger.info({
    msg: 'Retention cleanup completed',
    results
  });

  return results;
}

/**
 * Compress old TimescaleDB chunks.
 * Moves data from hot to warm tier.
 */
export async function compressOldChunks(): Promise<CompressionResult> {
  logger.info({ msg: 'Starting chunk compression' });

  try {
    // Compress samples older than hot retention period
    const samplesResult = await db.query(`
      SELECT compress_chunk(c)
      FROM show_chunks('health_samples', older_than => INTERVAL '${retentionConfig.samples.hot} days') c
      WHERE NOT is_compressed(c)
    `);

    // Compress aggregates older than hot retention period
    const aggResult = await db.query(`
      SELECT compress_chunk(c)
      FROM show_chunks('health_aggregates', older_than => INTERVAL '${retentionConfig.hourlyAggregates.hot} days') c
      WHERE NOT is_compressed(c)
    `);

    logger.info({
      msg: 'Chunk compression completed',
      samplesChunks: samplesResult.rowCount,
      aggregatesChunks: aggResult.rowCount
    });

    return {
      samplesChunks: samplesResult.rowCount,
      aggregatesChunks: aggResult.rowCount
    };
  } catch (error) {
    // TimescaleDB might not be installed in dev
    if ((error as Error).message.includes('function compress_chunk') ||
        (error as Error).message.includes('function show_chunks')) {
      logger.warn({
        msg: 'TimescaleDB compression not available (expected in development)'
      });
      return { skipped: true, reason: 'TimescaleDB not available' };
    }

    logger.error({
      msg: 'Chunk compression failed',
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Replay aggregation for a user and date range.
 * Used after bug fixes or data corrections.
 */
export async function replayAggregation(userId: string, startDate: Date, endDate: Date): Promise<void> {
  logger.info({
    msg: 'Starting aggregation replay',
    userId,
    startDate,
    endDate
  });

  // Delete existing aggregates in range
  await db.query(`
    DELETE FROM health_aggregates
    WHERE user_id = $1
      AND period_start >= $2
      AND period_start <= $3
  `, [userId, startDate, endDate]);

  // Import aggregation service dynamically to avoid circular deps
  const { aggregationService } = await import('../services/aggregationService.js');
  const { HealthDataTypes } = await import('../models/healthTypes.js');

  // Queue re-aggregation
  await aggregationService.queueAggregation(
    userId,
    Object.keys(HealthDataTypes),
    { start: startDate, end: endDate }
  );

  logger.info({
    msg: 'Aggregation replay queued',
    userId,
    startDate,
    endDate
  });
}

/**
 * Get retention policy status for a user.
 * Useful for admin dashboards.
 */
export async function getRetentionStatus(userId: string): Promise<RetentionStatusResult> {
  const result = await db.query<RetentionStatusResult>(`
    SELECT
      COUNT(*) FILTER (WHERE start_date >= NOW() - INTERVAL '${retentionConfig.samples.hot} days') as hot_samples,
      COUNT(*) FILTER (WHERE start_date < NOW() - INTERVAL '${retentionConfig.samples.hot} days') as warm_samples,
      MIN(start_date) as oldest_sample,
      MAX(start_date) as newest_sample
    FROM health_samples
    WHERE user_id = $1
  `, [userId]);

  return result.rows[0];
}

export default {
  retentionConfig,
  cacheTTLConfig,
  runRetentionCleanup,
  compressOldChunks,
  replayAggregation,
  getRetentionStatus
};
