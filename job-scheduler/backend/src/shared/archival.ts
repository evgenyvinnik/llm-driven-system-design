/**
 * Data archival module for the job scheduler.
 * Handles retention policies, archival to cold storage, and cleanup of old data.
 * Implements the data lifecycle policies defined in architecture.md.
 * @module shared/archival
 */

import { query } from '../db/pool';
import { logger } from '../utils/logger';
import { registerHandler, ExecutionContext } from '../worker/handlers';
import type { Job, JobExecution } from '../types';

/**
 * Retention configuration for different data types.
 */
export const retentionConfig = {
  /** Active executions retained in hot storage */
  activeExecutions: {
    retentionDays: 30,
    description: 'Job executions older than this are archived',
  },
  /** Execution logs retained in hot storage */
  executionLogs: {
    retentionDays: 7,
    description: 'Execution logs older than this are deleted',
  },
  /** Archived data retained in cold storage */
  archivedData: {
    retentionDays: 365,
    description: 'Archived data older than this is purged',
  },
  /** Dead letter queue items */
  deadLetter: {
    retentionDays: 30,
    description: 'Dead letter items older than this are purged',
  },
};

/**
 * Archive record stored in the database.
 */
export interface ArchiveRecord {
  id: string;
  partition_name: string;
  start_date: Date;
  end_date: Date;
  record_count: number;
  file_path: string;
  file_size_bytes: number;
  checksum: string;
  archived_at: Date;
}

/**
 * Cleanup statistics returned from cleanup operations.
 */
export interface CleanupStats {
  executionsDeleted: number;
  logsDeleted: number;
  executionTime: number;
}

/**
 * Deletes old execution records based on retention policy.
 * Only deletes completed, failed, or cancelled executions.
 * @param olderThanDays - Delete records older than this many days
 * @returns Number of records deleted
 */
export async function deleteOldExecutions(olderThanDays: number): Promise<number> {
  const startTime = Date.now();

  const result = await query<{ count: string }>(`
    WITH deleted AS (
      DELETE FROM job_executions
      WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'
        AND status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'DEDUPLICATED')
      RETURNING id
    )
    SELECT COUNT(*) as count FROM deleted
  `);

  const deletedCount = parseInt(result[0]?.count || '0', 10);
  const duration = Date.now() - startTime;

  logger.info(
    { deletedCount, olderThanDays, duration },
    'Deleted old execution records'
  );

  return deletedCount;
}

/**
 * Deletes old execution logs based on retention policy.
 * @param olderThanDays - Delete logs older than this many days
 * @returns Number of logs deleted
 */
export async function deleteOldLogs(olderThanDays: number): Promise<number> {
  const startTime = Date.now();

  const result = await query<{ count: string }>(`
    WITH deleted AS (
      DELETE FROM execution_logs
      WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'
      RETURNING id
    )
    SELECT COUNT(*) as count FROM deleted
  `);

  const deletedCount = parseInt(result[0]?.count || '0', 10);
  const duration = Date.now() - startTime;

  logger.info(
    { deletedCount, olderThanDays, duration },
    'Deleted old execution logs'
  );

  return deletedCount;
}

/**
 * Gets counts of records to be cleaned up.
 * Useful for dry-run and reporting.
 * @returns Object with counts for each category
 */
export async function getCleanupPreview(): Promise<{
  executionsToDelete: number;
  logsToDelete: number;
  oldestExecution: Date | null;
  oldestLog: Date | null;
}> {
  const executionDays = retentionConfig.activeExecutions.retentionDays;
  const logDays = retentionConfig.executionLogs.retentionDays;

  const [execResult, logResult, oldestExec, oldestLog] = await Promise.all([
    query<{ count: string }>(`
      SELECT COUNT(*) as count FROM job_executions
      WHERE created_at < NOW() - INTERVAL '${executionDays} days'
        AND status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'DEDUPLICATED')
    `),
    query<{ count: string }>(`
      SELECT COUNT(*) as count FROM execution_logs
      WHERE created_at < NOW() - INTERVAL '${logDays} days'
    `),
    query<{ oldest: Date }>(`
      SELECT MIN(created_at) as oldest FROM job_executions
    `),
    query<{ oldest: Date }>(`
      SELECT MIN(created_at) as oldest FROM execution_logs
    `),
  ]);

  return {
    executionsToDelete: parseInt(execResult[0]?.count || '0', 10),
    logsToDelete: parseInt(logResult[0]?.count || '0', 10),
    oldestExecution: oldestExec[0]?.oldest || null,
    oldestLog: oldestLog[0]?.oldest || null,
  };
}

/**
 * Runs the full cleanup process.
 * Deletes old executions and logs based on retention policies.
 * @returns Cleanup statistics
 */
export async function runCleanup(): Promise<CleanupStats> {
  const startTime = Date.now();

  logger.info('Starting data cleanup process');

  const [executionsDeleted, logsDeleted] = await Promise.all([
    deleteOldExecutions(retentionConfig.activeExecutions.retentionDays),
    deleteOldLogs(retentionConfig.executionLogs.retentionDays),
  ]);

  const stats: CleanupStats = {
    executionsDeleted,
    logsDeleted,
    executionTime: Date.now() - startTime,
  };

  logger.info({ ...stats }, 'Data cleanup completed');

  return stats;
}

/**
 * Exports execution records to archive format.
 * Creates a JSON export for cold storage.
 * @param startDate - Start of date range
 * @param endDate - End of date range
 * @returns Archive data ready for storage
 */
export async function exportExecutionsForArchive(
  startDate: Date,
  endDate: Date
): Promise<{
  executions: JobExecution[];
  logs: unknown[];
  metadata: {
    startDate: string;
    endDate: string;
    exportedAt: string;
    recordCount: number;
  };
}> {
  const executions = await query<JobExecution>(`
    SELECT * FROM job_executions
    WHERE created_at >= $1 AND created_at < $2
    ORDER BY created_at ASC
  `, [startDate, endDate]);

  const executionIds = executions.map(e => e.id);

  let logs: unknown[] = [];
  if (executionIds.length > 0) {
    logs = await query(`
      SELECT * FROM execution_logs
      WHERE execution_id = ANY($1)
      ORDER BY created_at ASC
    `, [executionIds]);
  }

  return {
    executions,
    logs,
    metadata: {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      exportedAt: new Date().toISOString(),
      recordCount: executions.length,
    },
  };
}

/**
 * Gets database storage statistics.
 * Useful for monitoring and capacity planning.
 */
export async function getStorageStats(): Promise<{
  jobs: { count: number; sizeBytes: number };
  executions: { count: number; sizeBytes: number };
  logs: { count: number; sizeBytes: number };
  total: { sizeBytes: number };
}> {
  const result = await query<{
    table_name: string;
    row_count: string;
    size_bytes: string;
  }>(`
    SELECT
      relname as table_name,
      n_live_tup as row_count,
      pg_total_relation_size(relid) as size_bytes
    FROM pg_stat_user_tables
    WHERE relname IN ('jobs', 'job_executions', 'execution_logs')
  `);

  const stats = {
    jobs: { count: 0, sizeBytes: 0 },
    executions: { count: 0, sizeBytes: 0 },
    logs: { count: 0, sizeBytes: 0 },
    total: { sizeBytes: 0 },
  };

  for (const row of result) {
    const count = parseInt(row.row_count, 10);
    const size = parseInt(row.size_bytes, 10);

    switch (row.table_name) {
      case 'jobs':
        stats.jobs = { count, sizeBytes: size };
        break;
      case 'job_executions':
        stats.executions = { count, sizeBytes: size };
        break;
      case 'execution_logs':
        stats.logs = { count, sizeBytes: size };
        break;
    }
    stats.total.sizeBytes += size;
  }

  return stats;
}

/**
 * Registers the maintenance handler for scheduled cleanup.
 * This handler runs as a job to perform routine maintenance.
 */
registerHandler('system.maintenance', async (
  job: Job,
  execution: JobExecution,
  context: ExecutionContext
) => {
  await context.log('info', 'Starting scheduled maintenance');

  const preview = await getCleanupPreview();
  await context.log('info', `Cleanup preview: ${preview.executionsToDelete} executions, ${preview.logsToDelete} logs to delete`);

  const stats = await runCleanup();

  await context.log('info', `Cleanup completed: ${stats.executionsDeleted} executions, ${stats.logsDeleted} logs deleted in ${stats.executionTime}ms`);

  const storageStats = await getStorageStats();
  await context.log('info', `Storage stats: ${JSON.stringify(storageStats)}`);

  return {
    cleanup: stats,
    storage: storageStats,
  };
});

/**
 * Runs VACUUM ANALYZE on specified tables.
 * Helps reclaim space after deletions and updates statistics.
 * @param tables - Tables to vacuum
 */
export async function vacuumTables(tables: string[]): Promise<void> {
  for (const table of tables) {
    // Validate table name to prevent SQL injection
    if (!['jobs', 'job_executions', 'execution_logs'].includes(table)) {
      logger.warn({ table }, 'Skipping invalid table name for vacuum');
      continue;
    }

    await query(`VACUUM ANALYZE ${table}`);
    logger.info({ table }, 'Vacuumed table');
  }
}

logger.info('Archival module initialized');
