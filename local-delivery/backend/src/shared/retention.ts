/**
 * Data retention configuration and cleanup service.
 * Manages lifecycle policies for orders, location history, and other data.
 *
 * WHY data retention:
 * - Balances historical data needs vs storage costs
 * - Ensures compliance with data retention regulations
 * - Prevents unbounded database growth
 * - Enables efficient queries on recent data
 *
 * Policies:
 * - Orders: 30 days hot (PostgreSQL) -> 365 days warm -> 7 years archive (MinIO)
 * - Driver location history: 7 days hot -> 30 days warm -> deleted
 * - Sessions: 1 day hot -> deleted
 *
 * @module shared/retention
 */
import { query, queryOne, execute } from '../utils/db.js';
import { logger } from './logger.js';

/**
 * Retention policy configuration.
 */
export interface RetentionPolicy {
  id: string;
  table_name: string;
  hot_storage_days: number;
  warm_storage_days: number;
  archive_enabled: boolean;
  last_cleanup_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Default retention periods in days.
 */
export const DEFAULT_RETENTION = {
  orders: {
    hot: 30,      // Keep in main table for 30 days
    warm: 365,    // Keep in partitioned table for 1 year
    archive: 2555, // Archive to cold storage for 7 years
  },
  driver_location_history: {
    hot: 7,       // Recent locations for tracking
    warm: 30,     // Aggregated for analytics
    delete: true, // No long-term archive needed
  },
  sessions: {
    hot: 1,       // Active sessions
    warm: 7,      // For audit purposes
    delete: true, // Delete after audit period
  },
  driver_offers: {
    hot: 7,       // Recent offers for acceptance rate
    warm: 90,     // Historical analysis
    archive: 365, // Compliance
  },
};

/**
 * Gets all retention policies.
 */
export async function getRetentionPolicies(): Promise<RetentionPolicy[]> {
  return query<RetentionPolicy>(`SELECT * FROM retention_policies ORDER BY table_name`);
}

/**
 * Gets a specific retention policy.
 */
export async function getRetentionPolicy(tableName: string): Promise<RetentionPolicy | null> {
  return queryOne<RetentionPolicy>(
    `SELECT * FROM retention_policies WHERE table_name = $1`,
    [tableName]
  );
}

/**
 * Updates a retention policy.
 */
export async function updateRetentionPolicy(
  tableName: string,
  updates: Partial<Pick<RetentionPolicy, 'hot_storage_days' | 'warm_storage_days' | 'archive_enabled'>>
): Promise<RetentionPolicy | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.hot_storage_days !== undefined) {
    setClauses.push(`hot_storage_days = $${paramIndex++}`);
    values.push(updates.hot_storage_days);
  }
  if (updates.warm_storage_days !== undefined) {
    setClauses.push(`warm_storage_days = $${paramIndex++}`);
    values.push(updates.warm_storage_days);
  }
  if (updates.archive_enabled !== undefined) {
    setClauses.push(`archive_enabled = $${paramIndex++}`);
    values.push(updates.archive_enabled);
  }

  if (setClauses.length === 0) {
    return getRetentionPolicy(tableName);
  }

  values.push(tableName);

  return queryOne<RetentionPolicy>(
    `UPDATE retention_policies SET ${setClauses.join(', ')} WHERE table_name = $${paramIndex} RETURNING *`,
    values
  );
}

/**
 * Cleanup result summary.
 */
export interface CleanupResult {
  table: string;
  rowsDeleted: number;
  rowsArchived: number;
  duration_ms: number;
}

/**
 * Runs cleanup for orders table.
 * Deletes archived orders older than warm storage period.
 */
export async function cleanupOrders(): Promise<CleanupResult> {
  const start = Date.now();
  const policy = await getRetentionPolicy('orders');

  if (!policy) {
    return { table: 'orders', rowsDeleted: 0, rowsArchived: 0, duration_ms: Date.now() - start };
  }

  // Delete orders that have been archived and are older than warm storage
  const deletedCount = await execute(
    `DELETE FROM orders
     WHERE archived_at IS NOT NULL
     AND created_at < NOW() - INTERVAL '1 day' * $1`,
    [policy.warm_storage_days]
  );

  // Mark old unarchived orders for archival
  const archivedCount = await execute(
    `UPDATE orders
     SET archived_at = NOW()
     WHERE archived_at IS NULL
     AND created_at < NOW() - INTERVAL '1 day' * $1`,
    [policy.hot_storage_days]
  );

  // Update last cleanup time
  await execute(
    `UPDATE retention_policies SET last_cleanup_at = NOW() WHERE table_name = 'orders'`
  );

  logger.info({
    table: 'orders',
    deleted: deletedCount,
    archived: archivedCount,
  }, 'Orders cleanup completed');

  return {
    table: 'orders',
    rowsDeleted: deletedCount,
    rowsArchived: archivedCount,
    duration_ms: Date.now() - start,
  };
}

/**
 * Runs cleanup for driver location history.
 * Deletes old location records.
 */
export async function cleanupDriverLocationHistory(): Promise<CleanupResult> {
  const start = Date.now();
  const policy = await getRetentionPolicy('driver_location_history');

  if (!policy) {
    return { table: 'driver_location_history', rowsDeleted: 0, rowsArchived: 0, duration_ms: Date.now() - start };
  }

  const deletedCount = await execute(
    `DELETE FROM driver_location_history
     WHERE recorded_at < NOW() - INTERVAL '1 day' * $1`,
    [policy.warm_storage_days]
  );

  await execute(
    `UPDATE retention_policies SET last_cleanup_at = NOW() WHERE table_name = 'driver_location_history'`
  );

  logger.info({
    table: 'driver_location_history',
    deleted: deletedCount,
  }, 'Driver location history cleanup completed');

  return {
    table: 'driver_location_history',
    rowsDeleted: deletedCount,
    rowsArchived: 0,
    duration_ms: Date.now() - start,
  };
}

/**
 * Runs cleanup for sessions.
 * Deletes expired sessions.
 */
export async function cleanupSessions(): Promise<CleanupResult> {
  const start = Date.now();

  const deletedCount = await execute(
    `DELETE FROM sessions WHERE expires_at < NOW()`
  );

  logger.info({
    table: 'sessions',
    deleted: deletedCount,
  }, 'Sessions cleanup completed');

  return {
    table: 'sessions',
    rowsDeleted: deletedCount,
    rowsArchived: 0,
    duration_ms: Date.now() - start,
  };
}

/**
 * Runs cleanup for driver offers.
 * Deletes old offer records.
 */
export async function cleanupDriverOffers(): Promise<CleanupResult> {
  const start = Date.now();
  const policy = await getRetentionPolicy('driver_offers');

  if (!policy) {
    return { table: 'driver_offers', rowsDeleted: 0, rowsArchived: 0, duration_ms: Date.now() - start };
  }

  const deletedCount = await execute(
    `DELETE FROM driver_offers
     WHERE offered_at < NOW() - INTERVAL '1 day' * $1`,
    [policy.warm_storage_days]
  );

  await execute(
    `UPDATE retention_policies SET last_cleanup_at = NOW() WHERE table_name = 'driver_offers'`
  );

  logger.info({
    table: 'driver_offers',
    deleted: deletedCount,
  }, 'Driver offers cleanup completed');

  return {
    table: 'driver_offers',
    rowsDeleted: deletedCount,
    rowsArchived: 0,
    duration_ms: Date.now() - start,
  };
}

/**
 * Runs all cleanup jobs.
 * Should be called periodically (e.g., daily via cron).
 */
export async function runAllCleanupJobs(): Promise<CleanupResult[]> {
  logger.info('Starting data retention cleanup');

  const results: CleanupResult[] = [];

  try {
    results.push(await cleanupOrders());
    results.push(await cleanupDriverLocationHistory());
    results.push(await cleanupSessions());
    results.push(await cleanupDriverOffers());
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Cleanup job failed');
    throw error;
  }

  const totalDeleted = results.reduce((sum, r) => sum + r.rowsDeleted, 0);
  const totalArchived = results.reduce((sum, r) => sum + r.rowsArchived, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.duration_ms, 0);

  logger.info({
    totalDeleted,
    totalArchived,
    totalDuration_ms: totalDuration,
  }, 'Data retention cleanup completed');

  return results;
}

export default {
  getRetentionPolicies,
  getRetentionPolicy,
  updateRetentionPolicy,
  cleanupOrders,
  cleanupDriverLocationHistory,
  cleanupSessions,
  cleanupDriverOffers,
  runAllCleanupJobs,
  DEFAULT_RETENTION,
};
