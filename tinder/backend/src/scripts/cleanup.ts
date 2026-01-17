import { pool } from '../db/index.js';
import { retentionService } from '../shared/retention.js';
import { logger } from '../shared/logger.js';

/**
 * Data cleanup script for scheduled execution.
 * Runs all retention cleanup tasks and reports results.
 *
 * Run with: npm run db:cleanup
 *
 * Recommended cron schedule:
 * - Weekly for swipes: 0 0 * * 0  (midnight Sunday)
 * - Monthly for messages: 0 0 1 * * (midnight, 1st of month)
 */

async function main() {
  logger.info('Starting scheduled data cleanup');

  try {
    const results = await retentionService.runAllCleanups();

    logger.info(
      {
        swipesDeleted: results.swipesDeleted,
        messagesDeleted: results.messagesDeleted,
        cacheKeysCleaned: results.cacheKeysCleaned,
      },
      'Cleanup completed successfully'
    );

    // Output summary
    console.log('\n=== Cleanup Summary ===');
    console.log(`Swipes deleted: ${results.swipesDeleted}`);
    console.log(`Messages deleted: ${results.messagesDeleted}`);
    console.log(`Cache keys cleaned: ${results.cacheKeysCleaned}`);
    console.log('=======================\n');
  } catch (error) {
    logger.error({ error }, 'Cleanup failed');
    console.error('Cleanup failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

main();
