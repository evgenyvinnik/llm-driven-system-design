/**
 * Message Cleanup Job Module
 *
 * Implements message retention policies through periodic cleanup jobs.
 * Prevents unbounded storage growth by removing old messages beyond the
 * configured retention limits.
 *
 * WHY Message Retention Policies Prevent Unbounded Storage Costs:
 * - Without cleanup, message tables grow indefinitely
 * - Large tables degrade query performance (slower JOINs, index scans)
 * - Storage costs increase linearly with message volume
 * - Database backups become slower and larger
 * - This cleanup job enforces configurable retention limits
 */

import { db } from '../db/index.js';
import { logger } from './logger.js';
import { messageRetention } from '../shared/config.js';
import {
  cleanupJobRuns,
  lastCleanupTimestamp,
  messagesDeleted,
} from '../shared/metrics.js';
import { server } from '../shared/config.js';

// ============================================================================
// Cleanup Job State
// ============================================================================

/** Timer reference for the cleanup interval */
let cleanupTimer: NodeJS.Timeout | null = null;

/** Whether a cleanup is currently in progress */
let isRunning = false;

// ============================================================================
// Cleanup Operations
// ============================================================================

/**
 * Run the message cleanup job.
 * Deletes messages that exceed retention limits.
 *
 * Retention strategies:
 * 1. Count-based: Keep only maxMessagesPerRoom per room
 * 2. Age-based: Delete messages older than maxMessageAgeHours (if > 0)
 *
 * @returns Promise resolving to number of messages deleted
 */
export async function runCleanup(): Promise<number> {
  if (isRunning) {
    logger.warn('Cleanup job already running, skipping');
    return 0;
  }

  isRunning = true;
  const startTime = process.hrtime.bigint();

  try {
    logger.info('Starting message cleanup job');

    let deletedCount = 0;

    // Strategy 1: Count-based cleanup (keep only N messages per room)
    const countResult = await cleanupByCount(messageRetention.maxMessagesPerRoom);
    deletedCount += countResult;

    // Strategy 2: Age-based cleanup (if enabled)
    if (messageRetention.maxMessageAgeHours > 0) {
      const ageResult = await cleanupByAge(messageRetention.maxMessageAgeHours);
      deletedCount += ageResult;
    }

    // Update metrics
    const labels = { instance: server.instanceId };
    cleanupJobRuns.labels({ ...labels, status: 'success' }).inc();
    lastCleanupTimestamp.labels(labels).set(Date.now() / 1000);
    messagesDeleted.labels(labels).inc(deletedCount);

    const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
    logger.info(
      { deletedCount, durationMs },
      `Message cleanup completed: ${deletedCount} messages deleted`
    );

    return deletedCount;
  } catch (error) {
    cleanupJobRuns.labels({ instance: server.instanceId, status: 'failure' }).inc();
    logger.error({ err: error }, 'Message cleanup job failed');
    throw error;
  } finally {
    isRunning = false;
  }
}

/**
 * Delete messages exceeding the count limit per room.
 * Uses a window function to identify messages beyond the limit.
 *
 * @param maxPerRoom - Maximum messages to keep per room
 * @returns Number of messages deleted
 */
async function cleanupByCount(maxPerRoom: number): Promise<number> {
  const query = `
    WITH ranked_messages AS (
      SELECT id, room_id,
             ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC) as rn
      FROM messages
    ),
    to_delete AS (
      SELECT id FROM ranked_messages WHERE rn > $1
    )
    DELETE FROM messages
    WHERE id IN (SELECT id FROM to_delete)
    RETURNING id
  `;

  const result = await db.query(query, [maxPerRoom]);
  return result.rowCount ?? 0;
}

/**
 * Delete messages older than the specified age.
 *
 * @param maxAgeHours - Maximum age in hours
 * @returns Number of messages deleted
 */
async function cleanupByAge(maxAgeHours: number): Promise<number> {
  const query = `
    DELETE FROM messages
    WHERE created_at < NOW() - INTERVAL '${maxAgeHours} hours'
    RETURNING id
  `;

  const result = await db.query(query);
  return result.rowCount ?? 0;
}

// ============================================================================
// Job Scheduling
// ============================================================================

/**
 * Start the periodic cleanup job.
 * Runs at the interval specified in messageRetention.cleanupIntervalMinutes.
 */
export function startCleanupJob(): void {
  if (cleanupTimer) {
    logger.warn('Cleanup job already started');
    return;
  }

  const intervalMs = messageRetention.cleanupIntervalMinutes * 60 * 1000;

  logger.info(
    { intervalMinutes: messageRetention.cleanupIntervalMinutes },
    'Starting message cleanup scheduler'
  );

  // Run immediately on startup, then periodically
  runCleanup().catch((err) => {
    logger.error({ err }, 'Initial cleanup job failed');
  });

  cleanupTimer = setInterval(() => {
    runCleanup().catch((err) => {
      logger.error({ err }, 'Scheduled cleanup job failed');
    });
  }, intervalMs);

  // Prevent the timer from keeping the process alive during shutdown
  cleanupTimer.unref();
}

/**
 * Stop the periodic cleanup job.
 * Should be called during graceful shutdown.
 */
export function stopCleanupJob(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    logger.info('Message cleanup scheduler stopped');
  }
}

/**
 * Check if the cleanup job is currently running.
 */
export function isCleanupRunning(): boolean {
  return isRunning;
}

// ============================================================================
// Manual Operations
// ============================================================================

/**
 * Get storage statistics for monitoring.
 * Returns message counts and sizes per room.
 */
export async function getStorageStats(): Promise<{
  totalMessages: number;
  messagesPerRoom: Array<{ roomName: string; count: number }>;
  tableSize: string;
}> {
  const countQuery = `
    SELECT r.name as "roomName", COUNT(m.id) as count
    FROM rooms r
    LEFT JOIN messages m ON r.id = m.room_id
    GROUP BY r.id, r.name
    ORDER BY count DESC
  `;

  const sizeQuery = `
    SELECT pg_size_pretty(pg_total_relation_size('messages')) as size
  `;

  const [countResult, sizeResult] = await Promise.all([
    db.query<{ roomName: string; count: string }>(countQuery),
    db.query<{ size: string }>(sizeQuery),
  ]);

  const messagesPerRoom = countResult.rows.map((row) => ({
    roomName: row.roomName,
    count: parseInt(row.count, 10),
  }));

  const totalMessages = messagesPerRoom.reduce((sum, room) => sum + room.count, 0);

  return {
    totalMessages,
    messagesPerRoom,
    tableSize: sizeResult.rows[0]?.size || 'unknown',
  };
}

export default {
  runCleanup,
  startCleanupJob,
  stopCleanupJob,
  isCleanupRunning,
  getStorageStats,
};
