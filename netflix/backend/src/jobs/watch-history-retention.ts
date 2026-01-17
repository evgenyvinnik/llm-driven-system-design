/**
 * Watch History Retention Job.
 *
 * Manages the lifecycle of viewing data to balance personalization needs
 * with privacy and storage considerations.
 *
 * Retention Policies:
 * - Active viewing progress: Keep indefinitely (Continue Watching feature)
 * - Completed views (watch history): 2 years retention
 * - Archived watch history: 5 years (cold storage)
 *
 * This job handles:
 * - Cleaning up old viewing progress for completed content
 * - Archiving old watch history before deletion
 * - Respecting user deletion requests (GDPR/CCPA)
 *
 * Privacy Considerations:
 * - Balances personalization (needs viewing history) with privacy (data minimization)
 * - Older data is less valuable for recommendations
 * - Archival supports auditing while reducing hot storage costs
 */
import { pool, query } from '../db/index.js';
import { jobLogger } from '../services/logger.js';
import { jobExecutions, jobDuration } from '../services/metrics.js';

/**
 * Retention configuration.
 */
export interface RetentionConfig {
  /** Days to retain viewing progress for completed items */
  completedProgressRetentionDays: number;
  /** Days to retain watch history in hot storage */
  watchHistoryRetentionDays: number;
  /** Batch size for deletion operations */
  batchSize: number;
  /** Whether to archive before deleting */
  archiveBeforeDelete: boolean;
}

/**
 * Default retention configuration.
 */
const DEFAULT_CONFIG: RetentionConfig = {
  completedProgressRetentionDays: 90, // 3 months for completed progress
  watchHistoryRetentionDays: 730, // 2 years for watch history
  batchSize: 1000,
  archiveBeforeDelete: true,
};

/**
 * Result of a cleanup job execution.
 */
export interface CleanupResult {
  success: boolean;
  viewingProgressDeleted: number;
  watchHistoryArchived: number;
  watchHistoryDeleted: number;
  errors: string[];
  durationMs: number;
}

/**
 * Archives old watch history records.
 * In production, this would write to cold storage (S3/MinIO).
 *
 * @param cutoffDate - Date before which records should be archived
 * @param batchSize - Number of records to process at once
 * @returns Number of records archived
 */
async function archiveWatchHistory(
  cutoffDate: Date,
  batchSize: number
): Promise<number> {
  // For this learning project, we'll create an archive table
  // In production, write to S3/MinIO as Parquet or JSON
  let totalArchived = 0;

  // Ensure archive table exists
  await query(`
    CREATE TABLE IF NOT EXISTS watch_history_archive (
      id UUID PRIMARY KEY,
      profile_id UUID NOT NULL,
      video_id UUID,
      episode_id UUID,
      watched_at TIMESTAMP NOT NULL,
      archived_at TIMESTAMP DEFAULT NOW()
    )
  `);

  while (true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Select batch to archive
      const result = await client.query(`
        SELECT id, profile_id, video_id, episode_id, watched_at
        FROM watch_history
        WHERE watched_at < $1
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `, [cutoffDate, batchSize]);

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        break;
      }

      // Insert into archive
      for (const row of result.rows) {
        await client.query(`
          INSERT INTO watch_history_archive (id, profile_id, video_id, episode_id, watched_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id) DO NOTHING
        `, [row.id, row.profile_id, row.video_id, row.episode_id, row.watched_at]);
      }

      // Delete from main table
      const ids = result.rows.map((r) => r.id);
      await client.query(`
        DELETE FROM watch_history
        WHERE id = ANY($1)
      `, [ids]);

      await client.query('COMMIT');
      totalArchived += result.rows.length;

      jobLogger.debug({
        batchArchived: result.rows.length,
        totalArchived,
      }, 'Archived batch of watch history');

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return totalArchived;
}

/**
 * Cleans up old viewing progress for completed items.
 * Keeps progress for items that are not completed (Continue Watching).
 *
 * @param cutoffDate - Date before which completed progress should be deleted
 * @param batchSize - Number of records to process at once
 * @returns Number of records deleted
 */
async function cleanupViewingProgress(
  cutoffDate: Date,
  batchSize: number
): Promise<number> {
  let totalDeleted = 0;

  while (true) {
    const result = await query<{ id: string }>(`
      DELETE FROM viewing_progress
      WHERE id IN (
        SELECT id FROM viewing_progress
        WHERE completed = true
          AND last_watched_at < $1
        LIMIT $2
      )
      RETURNING id
    `, [cutoffDate, batchSize]);

    if (result.length === 0) {
      break;
    }

    totalDeleted += result.length;

    jobLogger.debug({
      batchDeleted: result.length,
      totalDeleted,
    }, 'Deleted batch of viewing progress');
  }

  return totalDeleted;
}

/**
 * Deletes old archived watch history.
 * Final cleanup of very old data.
 *
 * @param cutoffDate - Date before which archived records should be deleted
 * @param batchSize - Number of records to process at once
 * @returns Number of records deleted
 */
async function deleteOldArchive(
  cutoffDate: Date,
  batchSize: number
): Promise<number> {
  let totalDeleted = 0;

  while (true) {
    const result = await query<{ id: string }>(`
      DELETE FROM watch_history_archive
      WHERE id IN (
        SELECT id FROM watch_history_archive
        WHERE archived_at < $1
        LIMIT $2
      )
      RETURNING id
    `, [cutoffDate, batchSize]);

    if (result.length === 0) {
      break;
    }

    totalDeleted += result.length;
  }

  return totalDeleted;
}

/**
 * Runs the watch history retention cleanup job.
 *
 * @param config - Retention configuration (uses defaults if not provided)
 * @returns Cleanup result with statistics
 */
export async function runWatchHistoryCleanup(
  config: Partial<RetentionConfig> = {}
): Promise<CleanupResult> {
  const startTime = Date.now();
  const mergedConfig: RetentionConfig = { ...DEFAULT_CONFIG, ...config };
  const errors: string[] = [];

  let viewingProgressDeleted = 0;
  let watchHistoryArchived = 0;
  let watchHistoryDeleted = 0;

  jobLogger.info({
    config: mergedConfig,
  }, 'Starting watch history cleanup job');

  try {
    // Calculate cutoff dates
    const progressCutoff = new Date();
    progressCutoff.setDate(progressCutoff.getDate() - mergedConfig.completedProgressRetentionDays);

    const historyCutoff = new Date();
    historyCutoff.setDate(historyCutoff.getDate() - mergedConfig.watchHistoryRetentionDays);

    // 1. Clean up old viewing progress for completed items
    try {
      viewingProgressDeleted = await cleanupViewingProgress(
        progressCutoff,
        mergedConfig.batchSize
      );
    } catch (error) {
      const errorMsg = `Failed to clean viewing progress: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      jobLogger.error({ error }, 'Failed to clean viewing progress');
    }

    // 2. Archive old watch history
    if (mergedConfig.archiveBeforeDelete) {
      try {
        watchHistoryArchived = await archiveWatchHistory(
          historyCutoff,
          mergedConfig.batchSize
        );
      } catch (error) {
        const errorMsg = `Failed to archive watch history: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        jobLogger.error({ error }, 'Failed to archive watch history');
      }
    } else {
      // Direct deletion without archiving
      try {
        const result = await query<{ count: string }>(`
          WITH deleted AS (
            DELETE FROM watch_history
            WHERE watched_at < $1
            RETURNING id
          )
          SELECT COUNT(*) FROM deleted
        `, [historyCutoff]);
        watchHistoryDeleted = parseInt(result[0]?.count || '0', 10);
      } catch (error) {
        const errorMsg = `Failed to delete watch history: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        jobLogger.error({ error }, 'Failed to delete watch history');
      }
    }

    // 3. Delete very old archived data (5 years)
    const archiveCutoff = new Date();
    archiveCutoff.setFullYear(archiveCutoff.getFullYear() - 5);

    try {
      const oldArchiveDeleted = await deleteOldArchive(archiveCutoff, mergedConfig.batchSize);
      jobLogger.info({ oldArchiveDeleted }, 'Deleted old archived watch history');
    } catch {
      // Archive table might not exist yet
    }

  } catch (error) {
    const errorMsg = `Unexpected error in cleanup job: ${error instanceof Error ? error.message : 'Unknown error'}`;
    errors.push(errorMsg);
    jobLogger.error({ error }, 'Unexpected error in cleanup job');
  }

  const durationMs = Date.now() - startTime;
  const success = errors.length === 0;

  // Record metrics
  jobExecutions.labels('watch_history_cleanup', success ? 'success' : 'failure').inc();
  jobDuration.labels('watch_history_cleanup').observe(durationMs / 1000);

  const result: CleanupResult = {
    success,
    viewingProgressDeleted,
    watchHistoryArchived,
    watchHistoryDeleted,
    errors,
    durationMs,
  };

  jobLogger.info({
    result,
  }, 'Completed watch history cleanup job');

  return result;
}

/**
 * Deletes all data for a specific profile.
 * Used for GDPR/CCPA data deletion requests.
 *
 * @param profileId - Profile ID to delete data for
 * @returns Number of records deleted
 */
export async function deleteProfileData(profileId: string): Promise<{
  viewingProgressDeleted: number;
  watchHistoryDeleted: number;
  myListDeleted: number;
  experimentAllocationsDeleted: number;
}> {
  jobLogger.info({ profileId }, 'Deleting all data for profile');

  const [vpResult, whResult, mlResult, eaResult] = await Promise.all([
    query<{ count: string }>(`
      WITH deleted AS (
        DELETE FROM viewing_progress WHERE profile_id = $1 RETURNING id
      ) SELECT COUNT(*) FROM deleted
    `, [profileId]),
    query<{ count: string }>(`
      WITH deleted AS (
        DELETE FROM watch_history WHERE profile_id = $1 RETURNING id
      ) SELECT COUNT(*) FROM deleted
    `, [profileId]),
    query<{ count: string }>(`
      WITH deleted AS (
        DELETE FROM my_list WHERE profile_id = $1 RETURNING id
      ) SELECT COUNT(*) FROM deleted
    `, [profileId]),
    query<{ count: string }>(`
      WITH deleted AS (
        DELETE FROM experiment_allocations WHERE profile_id = $1 RETURNING id
      ) SELECT COUNT(*) FROM deleted
    `, [profileId]),
  ]);

  const result = {
    viewingProgressDeleted: parseInt(vpResult[0]?.count || '0', 10),
    watchHistoryDeleted: parseInt(whResult[0]?.count || '0', 10),
    myListDeleted: parseInt(mlResult[0]?.count || '0', 10),
    experimentAllocationsDeleted: parseInt(eaResult[0]?.count || '0', 10),
  };

  jobLogger.info({ profileId, result }, 'Completed profile data deletion');

  return result;
}

/**
 * Schedules the cleanup job to run periodically.
 * Uses setInterval for simplicity - in production, use a proper job scheduler.
 *
 * @param intervalMs - Interval between job runs (default: 24 hours)
 * @param config - Retention configuration
 * @returns Function to stop the scheduler
 */
export function scheduleCleanupJob(
  intervalMs = 24 * 60 * 60 * 1000, // 24 hours
  config?: Partial<RetentionConfig>
): () => void {
  jobLogger.info({ intervalMs }, 'Scheduling watch history cleanup job');

  const intervalId = setInterval(async () => {
    try {
      await runWatchHistoryCleanup(config);
    } catch (error) {
      jobLogger.error({ error }, 'Scheduled cleanup job failed');
    }
  }, intervalMs);

  // Return cleanup function
  return () => {
    clearInterval(intervalId);
    jobLogger.info('Stopped watch history cleanup scheduler');
  };
}

/**
 * Gets statistics about viewing data.
 * Useful for monitoring data growth and retention effectiveness.
 */
export async function getViewingDataStats(): Promise<{
  viewingProgressCount: number;
  viewingProgressCompletedCount: number;
  watchHistoryCount: number;
  watchHistoryOldestDate: Date | null;
  archiveCount: number;
}> {
  const [vpCount, vpCompletedCount, whCount, whOldest, archiveCount] = await Promise.all([
    query<{ count: string }>('SELECT COUNT(*) FROM viewing_progress'),
    query<{ count: string }>('SELECT COUNT(*) FROM viewing_progress WHERE completed = true'),
    query<{ count: string }>('SELECT COUNT(*) FROM watch_history'),
    query<{ oldest: Date }>('SELECT MIN(watched_at) as oldest FROM watch_history'),
    query<{ count: string }>('SELECT COUNT(*) FROM watch_history_archive').catch(() => [{ count: '0' }]),
  ]);

  return {
    viewingProgressCount: parseInt(vpCount[0]?.count || '0', 10),
    viewingProgressCompletedCount: parseInt(vpCompletedCount[0]?.count || '0', 10),
    watchHistoryCount: parseInt(whCount[0]?.count || '0', 10),
    watchHistoryOldestDate: whOldest[0]?.oldest || null,
    archiveCount: parseInt(archiveCount[0]?.count || '0', 10),
  };
}
