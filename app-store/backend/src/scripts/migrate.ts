/**
 * Database migration runner
 * Usage: npm run db:migrate
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate(): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'init.sql'), 'utf-8');

  try {
    await pool.query(sql);
    console.log('Database migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
