/**
 * @fileoverview Migration status script.
 * Displays the current state of database migrations.
 */

import { pool } from '../config/database.js';
import { getMigrationStatus } from '../shared/migrations.js';
import * as path from 'path';

async function main() {
  // Use process.cwd() for CommonJS compatibility
  const migrationsDir = path.join(process.cwd(), 'src/db/migrations');

  console.log('Checking migration status...\n');

  try {
    const status = await getMigrationStatus(migrationsDir);

    console.log('=== Applied Migrations ===');
    if (status.applied.length === 0) {
      console.log('  (none)');
    } else {
      for (const migration of status.applied) {
        console.log(`  [x] ${migration.name} (applied: ${migration.applied_at.toISOString()})`);
      }
    }

    console.log('\n=== Pending Migrations ===');
    if (status.pending.length === 0) {
      console.log('  (none - database is up to date)');
    } else {
      for (const name of status.pending) {
        console.log(`  [ ] ${name}`);
      }
    }

    console.log('\n=== Summary ===');
    console.log(`  Current version: ${status.current || '(none)'}`);
    console.log(`  Applied: ${status.applied.length}`);
    console.log(`  Pending: ${status.pending.length}`);
  } catch (error) {
    console.error('Failed to get migration status:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
