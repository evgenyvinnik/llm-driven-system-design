/**
 * Database migration script
 * Usage: npm run db:migrate
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../models/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate(): Promise<void> {
  console.log('Running database migrations...');

  try {
    // Read the init.sql file
    const initSqlPath = path.join(__dirname, 'init.sql');
    const initSql = fs.readFileSync(initSqlPath, 'utf8');

    // Execute the SQL
    await db.query(initSql);

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await db.end();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
