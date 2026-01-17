import { pool } from '../db/index.js';
import { logger } from '../shared/logger.js';
import { RETENTION_CONFIG } from '../shared/config.js';

/**
 * Service for managing data lifecycle and archival.
 *
 * WHY MEETING ARCHIVAL BALANCES HISTORY VS STORAGE COSTS:
 * Scheduling systems accumulate booking data rapidly. Without archival:
 * - Database tables grow unbounded, slowing queries
 * - Index maintenance becomes expensive
 * - Backup and restore times increase
 * - Storage costs escalate
 *
 * The archival strategy addresses this by:
 * 1. Keeping active/recent bookings in the main table for fast access
 * 2. Moving completed bookings to an archive table after 90 days
 * 3. Retaining archived data for 2 years for legal/audit compliance
 * 4. Permanently deleting data after the archive retention period
 *
 * This approach:
 * - Maintains fast query performance for active bookings
 * - Preserves historical data for analytics and auditing
 * - Controls storage growth predictably
 * - Supports GDPR/compliance requirements for data retention
 */
export class ArchivalService {
  /**
   * Archives completed and cancelled bookings older than the retention period.
   * Moves records from bookings table to bookings_archive table.
   * @returns Number of bookings archived
   */
  async archiveOldBookings(): Promise<number> {
    const retentionDays = RETENTION_CONFIG.COMPLETED_BOOKING_RETENTION_DAYS;
    const archiveLogger = logger.child({ operation: 'archiveBookings', retentionDays });

    archiveLogger.info('Starting booking archival process');

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Insert into archive table
      const insertResult = await client.query(`
        INSERT INTO bookings_archive (
          id, meeting_type_id, host_user_id, invitee_name, invitee_email,
          start_time, end_time, invitee_timezone, status, cancellation_reason,
          notes, created_at, updated_at, version, idempotency_key
        )
        SELECT
          id, meeting_type_id, host_user_id, invitee_name, invitee_email,
          start_time, end_time, invitee_timezone, status, cancellation_reason,
          notes, created_at, updated_at, version, idempotency_key
        FROM bookings
        WHERE status IN ('completed', 'cancelled')
          AND end_time < NOW() - INTERVAL '${retentionDays} days'
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `);

      const archivedCount = insertResult.rowCount || 0;

      if (archivedCount > 0) {
        // Delete from main table
        await client.query(`
          DELETE FROM bookings
          WHERE status IN ('completed', 'cancelled')
            AND end_time < NOW() - INTERVAL '${retentionDays} days'
        `);
      }

      await client.query('COMMIT');

      archiveLogger.info({ archivedCount }, 'Booking archival completed');
      return archivedCount;
    } catch (error) {
      await client.query('ROLLBACK');
      archiveLogger.error({ error }, 'Booking archival failed');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Permanently deletes archived bookings older than the archive retention period.
   * @returns Number of bookings permanently deleted
   */
  async purgeOldArchives(): Promise<number> {
    const archiveRetentionDays = RETENTION_CONFIG.ARCHIVE_RETENTION_DAYS;
    const purgeLogger = logger.child({ operation: 'purgeArchives', archiveRetentionDays });

    purgeLogger.info('Starting archive purge process');

    try {
      const result = await pool.query(`
        DELETE FROM bookings_archive
        WHERE archived_at < NOW() - INTERVAL '${archiveRetentionDays} days'
        RETURNING id
      `);

      const purgedCount = result.rowCount || 0;
      purgeLogger.info({ purgedCount }, 'Archive purge completed');
      return purgedCount;
    } catch (error) {
      purgeLogger.error({ error }, 'Archive purge failed');
      throw error;
    }
  }

  /**
   * Cleans up expired calendar event cache entries.
   * @returns Number of cache entries deleted
   */
  async cleanupCalendarCache(): Promise<number> {
    const cleanupLogger = logger.child({ operation: 'cleanupCalendarCache' });

    try {
      const result = await pool.query(`
        DELETE FROM calendar_events_cache
        WHERE expires_at < NOW()
        RETURNING id
      `);

      const deletedCount = result.rowCount || 0;
      cleanupLogger.info({ deletedCount }, 'Calendar cache cleanup completed');
      return deletedCount;
    } catch (error) {
      cleanupLogger.error({ error }, 'Calendar cache cleanup failed');
      throw error;
    }
  }

  /**
   * Cleans up old email notification logs.
   * @returns Number of email logs deleted
   */
  async cleanupEmailLogs(): Promise<number> {
    const retentionDays = RETENTION_CONFIG.EMAIL_LOG_RETENTION_DAYS;
    const cleanupLogger = logger.child({ operation: 'cleanupEmailLogs', retentionDays });

    try {
      const result = await pool.query(`
        DELETE FROM email_notifications
        WHERE sent_at < NOW() - INTERVAL '${retentionDays} days'
        RETURNING id
      `);

      const deletedCount = result.rowCount || 0;
      cleanupLogger.info({ deletedCount }, 'Email log cleanup completed');
      return deletedCount;
    } catch (error) {
      cleanupLogger.error({ error }, 'Email log cleanup failed');
      throw error;
    }
  }

  /**
   * Restores archived bookings for a user.
   * Used for support cases where historical data needs to be recovered.
   * @param userId - The UUID of the user
   * @param fromDate - Optional start date for restoration
   * @returns Number of bookings restored
   */
  async restoreArchivedBookings(
    userId: string,
    fromDate?: Date
  ): Promise<number> {
    const restoreLogger = logger.child({ operation: 'restoreArchived', userId });

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      let whereClause = 'host_user_id = $1';
      const params: (string | Date)[] = [userId];

      if (fromDate) {
        whereClause += ' AND start_time >= $2';
        params.push(fromDate);
      }

      // Insert from archive back to main table
      const insertResult = await client.query(`
        INSERT INTO bookings (
          id, meeting_type_id, host_user_id, invitee_name, invitee_email,
          start_time, end_time, invitee_timezone, status, cancellation_reason,
          notes, created_at, updated_at, version, idempotency_key
        )
        SELECT
          id, meeting_type_id, host_user_id, invitee_name, invitee_email,
          start_time, end_time, invitee_timezone, status, cancellation_reason,
          notes, created_at, updated_at, version, idempotency_key
        FROM bookings_archive
        WHERE ${whereClause}
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `, params);

      const restoredCount = insertResult.rowCount || 0;

      // Remove from archive
      if (restoredCount > 0) {
        await client.query(`
          DELETE FROM bookings_archive
          WHERE ${whereClause}
        `, params);
      }

      await client.query('COMMIT');

      restoreLogger.info({ restoredCount }, 'Booking restoration completed');
      return restoredCount;
    } catch (error) {
      await client.query('ROLLBACK');
      restoreLogger.error({ error }, 'Booking restoration failed');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Gets storage statistics for monitoring.
   * @returns Object with table sizes and row counts
   */
  async getStorageStats(): Promise<{
    bookings: { count: number; sizeBytes: number };
    bookingsArchive: { count: number; sizeBytes: number };
    calendarCache: { count: number; sizeBytes: number };
    emailNotifications: { count: number; sizeBytes: number };
  }> {
    const [bookings, archive, calendar, email] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) as count,
          pg_total_relation_size('bookings') as size_bytes
        FROM bookings
      `),
      pool.query(`
        SELECT
          COUNT(*) as count,
          pg_total_relation_size('bookings_archive') as size_bytes
        FROM bookings_archive
      `).catch(() => ({ rows: [{ count: 0, size_bytes: 0 }] })),
      pool.query(`
        SELECT
          COUNT(*) as count,
          pg_total_relation_size('calendar_events_cache') as size_bytes
        FROM calendar_events_cache
      `).catch(() => ({ rows: [{ count: 0, size_bytes: 0 }] })),
      pool.query(`
        SELECT
          COUNT(*) as count,
          pg_total_relation_size('email_notifications') as size_bytes
        FROM email_notifications
      `),
    ]);

    return {
      bookings: {
        count: parseInt(bookings.rows[0].count),
        sizeBytes: parseInt(bookings.rows[0].size_bytes),
      },
      bookingsArchive: {
        count: parseInt(archive.rows[0].count),
        sizeBytes: parseInt(archive.rows[0].size_bytes),
      },
      calendarCache: {
        count: parseInt(calendar.rows[0].count),
        sizeBytes: parseInt(calendar.rows[0].size_bytes),
      },
      emailNotifications: {
        count: parseInt(email.rows[0].count),
        sizeBytes: parseInt(email.rows[0].size_bytes),
      },
    };
  }

  /**
   * Runs all cleanup and archival tasks.
   * Intended to be called by a cron job or scheduled task.
   */
  async runAllMaintenance(): Promise<{
    archivedBookings: number;
    purgedArchives: number;
    cleanedCalendarCache: number;
    cleanedEmailLogs: number;
  }> {
    logger.info('Starting full maintenance cycle');

    const [archivedBookings, purgedArchives, cleanedCalendarCache, cleanedEmailLogs] =
      await Promise.all([
        this.archiveOldBookings(),
        this.purgeOldArchives(),
        this.cleanupCalendarCache(),
        this.cleanupEmailLogs(),
      ]);

    logger.info(
      {
        archivedBookings,
        purgedArchives,
        cleanedCalendarCache,
        cleanedEmailLogs,
      },
      'Maintenance cycle completed'
    );

    return {
      archivedBookings,
      purgedArchives,
      cleanedCalendarCache,
      cleanedEmailLogs,
    };
  }
}

/** Singleton instance of ArchivalService */
export const archivalService = new ArchivalService();

export default archivalService;
