/**
 * @fileoverview Migration rollback script.
 * Rolls back the last applied migration.
 */

import { pool } from '../config/database.js';
import { rollbackLastMigration } from '../shared/migrations.js';
import * as path from 'path';

async function main() {
  // Use process.cwd() for CommonJS compatibility
  const migrationsDir = path.join(process.cwd(), 'src/db/migrations');

  console.log('Rolling back last migration...\n');

  try {
    const success = await rollbackLastMigration(migrationsDir);

    if (success) {
      console.log('\nRollback completed successfully!');
    } else {
      console.log('\nRollback failed or nothing to rollback.');
      process.exit(1);
    }
  } catch (error) {
    console.error('Rollback failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
