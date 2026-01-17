/**
 * Version history retention configuration and cleanup utilities.
 * Manages the lifecycle of file versions including auto-save retention,
 * operations log archival, and cleanup scheduling.
 */
import { query, execute } from '../db/postgres.js';
import { logger } from './logger.js';
import { cleanupJobCounter, fileVersionsGauge } from './metrics.js';
import cron from 'node-cron';

/**
 * Configuration for version history retention.
 * Balances undo capability with storage costs.
 */
export interface RetentionConfig {
  /** Days to retain auto-save versions (default: 90) */
  autoSaveRetentionDays: number;
  /** Minimum auto-save versions to keep per file regardless of age */
  minAutoSaveVersionsPerFile: number;
  /** Days to retain named/manual versions (default: indefinite via null) */
  namedVersionRetentionDays: number | null;
  /** Days to retain operations log (default: 30) */
  operationsLogRetentionDays: number;
  /** Days before hard-deleting soft-deleted files (default: 30) */
  softDeleteRetentionDays: number;
}

/**
 * Default retention configuration.
 * Tuned for typical local development and small-scale deployments.
 */
export const defaultRetentionConfig: RetentionConfig = {
  autoSaveRetentionDays: 90,
  minAutoSaveVersionsPerFile: 10,
  namedVersionRetentionDays: null, // Keep named versions indefinitely
  operationsLogRetentionDays: 30,
  softDeleteRetentionDays: 30,
};

let currentConfig: RetentionConfig = { ...defaultRetentionConfig };

/**
 * Gets the current retention configuration.
 * @returns Current retention config
 */
export function getRetentionConfig(): RetentionConfig {
  return { ...currentConfig };
}

/**
 * Updates the retention configuration.
 * @param config - Partial config to merge with current settings
 */
export function setRetentionConfig(config: Partial<RetentionConfig>): void {
  currentConfig = { ...currentConfig, ...config };
  logger.info({ config: currentConfig }, 'Updated retention configuration');
}

/**
 * Cleans up old auto-save versions beyond retention period.
 * Preserves minimum number of versions per file.
 * @param config - Optional override for retention config
 * @returns Promise resolving to number of deleted versions
 */
export async function cleanupOldAutoSaves(
  config: Partial<RetentionConfig> = {}
): Promise<number> {
  const opts = { ...currentConfig, ...config };

  try {
    // Delete auto-save versions older than retention period,
    // but keep at least minAutoSaveVersionsPerFile per file
    const result = await execute(`
      WITH ranked_versions AS (
        SELECT id, file_id,
          ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC) as rn
        FROM file_versions
        WHERE is_auto_save = true
      ),
      versions_to_keep AS (
        SELECT id FROM ranked_versions WHERE rn <= $2
      )
      DELETE FROM file_versions
      WHERE is_auto_save = true
        AND created_at < NOW() - INTERVAL '1 day' * $1
        AND id NOT IN (SELECT id FROM versions_to_keep)
    `, [opts.autoSaveRetentionDays, opts.minAutoSaveVersionsPerFile]);

    logger.info({
      deletedCount: result,
      retentionDays: opts.autoSaveRetentionDays,
      minKept: opts.minAutoSaveVersionsPerFile,
    }, 'Cleaned up old auto-save versions');

    cleanupJobCounter.inc({ job_type: 'auto_save_cleanup', status: 'success' });

    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup old auto-save versions');
    cleanupJobCounter.inc({ job_type: 'auto_save_cleanup', status: 'error' });
    throw error;
  }
}

/**
 * Cleans up old operations log entries beyond retention period.
 * @param config - Optional override for retention config
 * @returns Promise resolving to number of deleted operations
 */
export async function cleanupOldOperations(
  config: Partial<RetentionConfig> = {}
): Promise<number> {
  const opts = { ...currentConfig, ...config };

  try {
    const result = await execute(`
      DELETE FROM operations
      WHERE created_at < NOW() - INTERVAL '1 day' * $1
    `, [opts.operationsLogRetentionDays]);

    logger.info({
      deletedCount: result,
      retentionDays: opts.operationsLogRetentionDays,
    }, 'Cleaned up old operations log entries');

    cleanupJobCounter.inc({ job_type: 'operations_cleanup', status: 'success' });

    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup old operations');
    cleanupJobCounter.inc({ job_type: 'operations_cleanup', status: 'error' });
    throw error;
  }
}

/**
 * Hard-deletes files that have been soft-deleted beyond retention period.
 * @param config - Optional override for retention config
 * @returns Promise resolving to number of deleted files
 */
export async function cleanupSoftDeletedFiles(
  config: Partial<RetentionConfig> = {}
): Promise<number> {
  const opts = { ...currentConfig, ...config };

  try {
    // First delete related data
    await execute(`
      DELETE FROM file_versions
      WHERE file_id IN (
        SELECT id FROM files
        WHERE deleted_at IS NOT NULL
          AND deleted_at < NOW() - INTERVAL '1 day' * $1
      )
    `, [opts.softDeleteRetentionDays]);

    await execute(`
      DELETE FROM operations
      WHERE file_id IN (
        SELECT id FROM files
        WHERE deleted_at IS NOT NULL
          AND deleted_at < NOW() - INTERVAL '1 day' * $1
      )
    `, [opts.softDeleteRetentionDays]);

    // Then delete the files
    const result = await execute(`
      DELETE FROM files
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - INTERVAL '1 day' * $1
    `, [opts.softDeleteRetentionDays]);

    logger.info({
      deletedCount: result,
      retentionDays: opts.softDeleteRetentionDays,
    }, 'Cleaned up soft-deleted files');

    cleanupJobCounter.inc({ job_type: 'soft_delete_cleanup', status: 'success' });

    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup soft-deleted files');
    cleanupJobCounter.inc({ job_type: 'soft_delete_cleanup', status: 'error' });
    throw error;
  }
}

/**
 * Runs all cleanup tasks.
 * Typically called on a schedule (e.g., daily at 3 AM).
 */
export async function runAllCleanupTasks(): Promise<void> {
  logger.info('Starting scheduled cleanup tasks');

  try {
    await cleanupOldAutoSaves();
    await cleanupOldOperations();
    await cleanupSoftDeletedFiles();
    logger.info('All cleanup tasks completed successfully');
  } catch (error) {
    logger.error({ error }, 'One or more cleanup tasks failed');
  }
}

/**
 * Updates version metrics for monitoring.
 * Tracks version counts per file for retention monitoring.
 */
export async function updateVersionMetrics(): Promise<void> {
  try {
    const stats = await query<{
      file_id: string;
      auto_save_count: number;
      named_count: number;
    }>(`
      SELECT
        file_id,
        COUNT(*) FILTER (WHERE is_auto_save = true) as auto_save_count,
        COUNT(*) FILTER (WHERE is_auto_save = false) as named_count
      FROM file_versions
      GROUP BY file_id
    `);

    for (const stat of stats) {
      fileVersionsGauge.set(
        { file_id: stat.file_id, type: 'auto_save' },
        Number(stat.auto_save_count)
      );
      fileVersionsGauge.set(
        { file_id: stat.file_id, type: 'named' },
        Number(stat.named_count)
      );
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to update version metrics');
  }
}

let cleanupScheduled = false;

/**
 * Schedules daily cleanup tasks using node-cron.
 * Runs at 3 AM local time.
 */
export function scheduleCleanupTasks(): void {
  if (cleanupScheduled) {
    logger.warn('Cleanup tasks already scheduled');
    return;
  }

  // Run cleanup at 3 AM daily
  cron.schedule('0 3 * * *', async () => {
    await runAllCleanupTasks();
  });

  // Update metrics every hour
  cron.schedule('0 * * * *', async () => {
    await updateVersionMetrics();
  });

  cleanupScheduled = true;
  logger.info('Scheduled cleanup tasks: daily at 3:00 AM, metrics hourly');
}

export default {
  getRetentionConfig,
  setRetentionConfig,
  cleanupOldAutoSaves,
  cleanupOldOperations,
  cleanupSoftDeletedFiles,
  runAllCleanupTasks,
  scheduleCleanupTasks,
  updateVersionMetrics,
};
