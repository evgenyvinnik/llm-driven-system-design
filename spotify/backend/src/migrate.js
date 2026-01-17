import { pool } from '../db.js';
import { initializeDatabase } from '../db.js';
import { migrate } from './migrate.js';

async function runMigration() {
  try {
    await initializeDatabase();
    await migrate();
    console.log('Migration completed');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigration();
