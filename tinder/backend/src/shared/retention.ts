import { pool, redis } from '../db/index.js';
import { retentionConfig } from './config.js';
import { logger } from './logger.js';

/**
 * Data retention service for managing data lifecycle.
 * Implements cleanup policies for swipes, messages, and cache data.
 *
 * WHY message retention matters:
 * 1. User Experience: Users expect recent message history to be available
 * 2. Privacy: Limiting retention protects user privacy after relationships end
 * 3. Storage Optimization: Old message data consumes database resources
 * 4. Compliance: Many jurisdictions require data deletion policies
 * 5. Performance: Smaller tables improve query performance
 */
export class RetentionService {
  /**
   * Cleans up old swipes beyond the retention period.
   * Swipes older than configured days are deleted.
   * @returns Number of swipes deleted
   */
  async cleanupOldSwipes(): Promise<number> {
    const retentionDays = retentionConfig.swipeRetentionDays;

    logger.info({ retentionDays }, 'Starting swipe cleanup');

    const result = await pool.query(
      `DELETE FROM swipes
       WHERE created_at < NOW() - INTERVAL '1 day' * $1
       RETURNING id`,
      [retentionDays]
    );

    const deletedCount = result.rowCount || 0;
    logger.info({ deletedCount, retentionDays }, 'Swipe cleanup completed');

    return deletedCount;
  }

  /**
   * Cleans up messages from ended matches beyond retention period.
   * Only deletes messages from matches that have been unmatched.
   * @returns Number of messages deleted
   */
  async cleanupOldMessages(): Promise<number> {
    const retentionDays = retentionConfig.messageRetentionDays;

    logger.info({ retentionDays }, 'Starting message cleanup');

    // Delete messages from unmatched conversations older than retention period
    const result = await pool.query(
      `DELETE FROM messages
       WHERE match_id IN (
         SELECT id FROM matches
         WHERE unmatched_at IS NOT NULL
           AND unmatched_at < NOW() - INTERVAL '1 day' * $1
       )
       RETURNING id`,
      [retentionDays]
    );

    const deletedCount = result.rowCount || 0;
    logger.info({ deletedCount, retentionDays }, 'Message cleanup completed');

    return deletedCount;
  }

  /**
   * Cleans up stale Redis cache entries.
   * Redis TTLs handle most cleanup, but this catches orphaned keys.
   * @returns Number of keys cleaned up
   */
  async cleanupRedisCache(): Promise<number> {
    logger.info('Starting Redis cache cleanup');

    let cleanedCount = 0;

    // Find and remove orphaned swipe keys for users that no longer exist
    const swipeKeys = await redis.keys('swipes:*:*');

    for (const key of swipeKeys) {
      const match = key.match(/swipes:([^:]+):/);
      if (match) {
        const userId = match[1];
        const userExists = await pool.query(
          'SELECT 1 FROM users WHERE id = $1',
          [userId]
        );

        if (userExists.rowCount === 0) {
          await redis.del(key);
          cleanedCount++;
        }
      }
    }

    logger.info({ cleanedCount }, 'Redis cache cleanup completed');
    return cleanedCount;
  }

  /**
   * Archives old messages to cold storage before deletion.
   * For learning project, this exports to JSON format.
   * @returns Number of messages archived
   */
  async archiveOldMessages(): Promise<{ archivedCount: number; archiveData: object[] }> {
    const retentionDays = retentionConfig.messageRetentionDays;

    logger.info({ retentionDays }, 'Starting message archival');

    // Get messages to archive
    const result = await pool.query(
      `SELECT m.*, ma.user1_id, ma.user2_id, ma.unmatched_at
       FROM messages m
       JOIN matches ma ON m.match_id = ma.id
       WHERE ma.unmatched_at IS NOT NULL
         AND ma.unmatched_at < NOW() - INTERVAL '1 day' * $1`,
      [retentionDays]
    );

    const archiveData = result.rows;
    const archivedCount = archiveData.length;

    logger.info({ archivedCount }, 'Message archival completed');

    return { archivedCount, archiveData };
  }

  /**
   * Runs all cleanup tasks.
   * Intended to be called by a scheduled job (cron).
   */
  async runAllCleanups(): Promise<{
    swipesDeleted: number;
    messagesDeleted: number;
    cacheKeysCleaned: number;
  }> {
    logger.info('Starting full data cleanup');

    const [swipesDeleted, messagesDeleted, cacheKeysCleaned] = await Promise.all([
      this.cleanupOldSwipes(),
      this.cleanupOldMessages(),
      this.cleanupRedisCache(),
    ]);

    logger.info(
      { swipesDeleted, messagesDeleted, cacheKeysCleaned },
      'Full data cleanup completed'
    );

    return { swipesDeleted, messagesDeleted, cacheKeysCleaned };
  }

  /**
   * Gets retention configuration for API exposure.
   * Useful for admin dashboards and debugging.
   */
  getRetentionConfig() {
    return {
      swipeRetentionDays: retentionConfig.swipeRetentionDays,
      messageRetentionDays: retentionConfig.messageRetentionDays,
      swipeCacheTTL: retentionConfig.swipeCacheTTL,
      likesReceivedTTL: retentionConfig.likesReceivedTTL,
      locationCacheTTL: retentionConfig.locationCacheTTL,
      sessionTTL: retentionConfig.sessionTTL,
    };
  }
}

// Export singleton instance
export const retentionService = new RetentionService();
