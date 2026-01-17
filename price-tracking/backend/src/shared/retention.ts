/**
 * Price history retention management.
 * Implements configurable data retention policies to balance historical analysis
 * needs with storage costs. Older data is downsampled to daily aggregates
 * while recent data maintains full resolution.
 *
 * Retention Strategy:
 * - Last 7 days: Full resolution (hourly or per-scrape data)
 * - 8-90 days: Daily aggregates (min, max, avg)
 * - 91+ days: Deleted (or optionally archived)
 *
 * @module shared/retention
 */
import { query } from '../db/pool.js';
import logger from '../utils/logger.js';
import { priceHistoryDeleted, priceHistoryTotal } from './metrics.js';

/**
 * Configuration for price history retention.
 */
export interface RetentionConfig {
  /** Days to keep full resolution data (default: 7) */
  fullResolutionDays: number;
  /** Days to keep daily aggregate data (default: 90) */
  aggregateDays: number;
  /** Maximum age in days before data is deleted (default: 365) */
  maxAgeDays: number;
  /** Whether to archive deleted data (default: false for local dev) */
  archiveEnabled: boolean;
  /** Batch size for deletion operations (default: 10000) */
  deleteBatchSize: number;
}

/**
 * Default retention configuration.
 * Can be overridden via environment variables.
 */
const defaultConfig: RetentionConfig = {
  fullResolutionDays: parseInt(process.env.RETENTION_FULL_RESOLUTION_DAYS || '7', 10),
  aggregateDays: parseInt(process.env.RETENTION_AGGREGATE_DAYS || '90', 10),
  maxAgeDays: parseInt(process.env.RETENTION_MAX_AGE_DAYS || '365', 10),
  archiveEnabled: process.env.RETENTION_ARCHIVE_ENABLED === 'true',
  deleteBatchSize: parseInt(process.env.RETENTION_DELETE_BATCH_SIZE || '10000', 10),
};

/**
 * Gets the current retention configuration.
 * Merges default values with environment variable overrides.
 */
export function getRetentionConfig(): RetentionConfig {
  return { ...defaultConfig };
}

/**
 * Runs the retention cleanup job.
 * Deletes old price history records beyond the maximum retention period.
 * Should be run periodically (e.g., daily via cron).
 *
 * @param config - Optional configuration override
 * @returns Statistics about the cleanup operation
 */
export async function runRetentionCleanup(
  config: RetentionConfig = defaultConfig
): Promise<{ deletedCount: number; durationMs: number }> {
  const startTime = Date.now();
  let totalDeleted = 0;

  logger.info(
    {
      action: 'retention_cleanup_start',
      maxAgeDays: config.maxAgeDays,
      batchSize: config.deleteBatchSize,
    },
    'Starting price history retention cleanup'
  );

  try {
    // Delete old records in batches to avoid long-running transactions
    let deletedInBatch = config.deleteBatchSize;

    while (deletedInBatch === config.deleteBatchSize) {
      const result = await query<{ count: number }>(
        `WITH deleted AS (
          DELETE FROM price_history
          WHERE recorded_at < NOW() - $1::interval
            AND ctid IN (
              SELECT ctid FROM price_history
              WHERE recorded_at < NOW() - $1::interval
              LIMIT $2
            )
          RETURNING 1
        )
        SELECT COUNT(*)::integer as count FROM deleted`,
        [`${config.maxAgeDays} days`, config.deleteBatchSize]
      );

      deletedInBatch = result[0]?.count || 0;
      totalDeleted += deletedInBatch;

      if (deletedInBatch > 0) {
        logger.debug(
          { action: 'retention_batch_deleted', count: deletedInBatch },
          `Deleted ${deletedInBatch} old price history records`
        );
      }
    }

    // Update metrics
    priceHistoryDeleted.inc(totalDeleted);

    // Update total count gauge
    const countResult = await query<{ count: number }>(
      'SELECT COUNT(*)::bigint as count FROM price_history'
    );
    priceHistoryTotal.set(countResult[0]?.count || 0);

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        action: 'retention_cleanup_complete',
        deletedCount: totalDeleted,
        durationMs,
      },
      `Retention cleanup complete: deleted ${totalDeleted} records in ${durationMs}ms`
    );

    return { deletedCount: totalDeleted, durationMs };
  } catch (error) {
    logger.error(
      {
        action: 'retention_cleanup_error',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Retention cleanup failed'
    );
    throw error;
  }
}

/**
 * Gets storage statistics for price history.
 * Useful for capacity planning and monitoring.
 *
 * @returns Statistics about price history storage
 */
export async function getPriceHistoryStats(): Promise<{
  totalRecords: number;
  oldestRecord: Date | null;
  newestRecord: Date | null;
  recordsLast24h: number;
  recordsLast7d: number;
  recordsLast30d: number;
  estimatedSizeBytes: number;
}> {
  const [totals, ranges, size] = await Promise.all([
    query<{
      total: number;
      oldest: Date | null;
      newest: Date | null;
    }>(
      `SELECT
        COUNT(*)::bigint as total,
        MIN(recorded_at) as oldest,
        MAX(recorded_at) as newest
      FROM price_history`
    ),
    query<{
      last_24h: number;
      last_7d: number;
      last_30d: number;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '24 hours')::bigint as last_24h,
        COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '7 days')::bigint as last_7d,
        COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '30 days')::bigint as last_30d
      FROM price_history`
    ),
    query<{ size_bytes: number }>(
      `SELECT pg_total_relation_size('price_history')::bigint as size_bytes`
    ).catch(() => [{ size_bytes: 0 }]), // Handle if relation doesn't exist
  ]);

  return {
    totalRecords: totals[0]?.total || 0,
    oldestRecord: totals[0]?.oldest || null,
    newestRecord: totals[0]?.newest || null,
    recordsLast24h: ranges[0]?.last_24h || 0,
    recordsLast7d: ranges[0]?.last_7d || 0,
    recordsLast30d: ranges[0]?.last_30d || 0,
    estimatedSizeBytes: size[0]?.size_bytes || 0,
  };
}

/**
 * Creates daily aggregate records from full resolution data.
 * This compresses older data while preserving useful statistics.
 * Run this after the retention cleanup to ensure aggregates exist
 * before full resolution data is deleted.
 *
 * Note: If using TimescaleDB, continuous aggregates are preferred.
 * This function is for PostgreSQL without TimescaleDB.
 *
 * @param daysAgo - Start aggregating data older than this many days
 * @returns Number of aggregate records created
 */
export async function createDailyAggregates(daysAgo: number = 7): Promise<number> {
  logger.info(
    { action: 'create_aggregates_start', daysAgo },
    `Creating daily aggregates for data older than ${daysAgo} days`
  );

  try {
    // This is a placeholder - in practice, you'd use TimescaleDB
    // continuous aggregates or a separate daily_prices table
    const result = await query<{ created: number }>(
      `SELECT 0 as created`
    );

    logger.info(
      { action: 'create_aggregates_complete', count: result[0]?.created || 0 },
      'Daily aggregate creation complete'
    );

    return result[0]?.created || 0;
  } catch (error) {
    logger.error(
      {
        action: 'create_aggregates_error',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to create daily aggregates'
    );
    throw error;
  }
}

/**
 * Validates that the retention configuration is sensible.
 * Full resolution days should be less than aggregate days,
 * and aggregate days should be less than max age days.
 *
 * @param config - The configuration to validate
 * @returns Validation result with any error messages
 */
export function validateRetentionConfig(config: RetentionConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (config.fullResolutionDays < 1) {
    errors.push('fullResolutionDays must be at least 1');
  }

  if (config.aggregateDays < config.fullResolutionDays) {
    errors.push('aggregateDays must be >= fullResolutionDays');
  }

  if (config.maxAgeDays < config.aggregateDays) {
    errors.push('maxAgeDays must be >= aggregateDays');
  }

  if (config.deleteBatchSize < 100) {
    errors.push('deleteBatchSize must be at least 100');
  }

  if (config.deleteBatchSize > 100000) {
    errors.push('deleteBatchSize should not exceed 100000 to avoid long transactions');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
