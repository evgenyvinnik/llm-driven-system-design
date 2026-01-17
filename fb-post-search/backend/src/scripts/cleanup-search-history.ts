/**
 * @fileoverview Search history cleanup script.
 * Removes expired search history records based on retention policy.
 * Should be run as a scheduled job (e.g., daily cron).
 */

import { pool } from '../config/database.js';
import { cleanupSearchHistory } from '../shared/retention.js';

async function main() {
  console.log('Cleaning up expired search history...\n');

  try {
    const deletedCount = await cleanupSearchHistory();
    console.log(`\nDeleted ${deletedCount} expired search history records.`);
  } catch (error) {
    console.error('Cleanup failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
