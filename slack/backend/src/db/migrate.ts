/**
 * @fileoverview Database migration script.
 * Reads and executes init.sql against the PostgreSQL database.
 * Uses CREATE TABLE IF NOT EXISTS for idempotent re-runs.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { pool } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate(): Promise<void> {
  console.log('Running database migration...');

  try {
    const sqlPath = path.join(__dirname, 'init.sql');
    const sql = await readFile(sqlPath, 'utf-8');

    await pool.query(sql);

    console.log('Migration completed successfully.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
