/**
 * Database migration runner
 * Usage: npm run db:migrate
 */
import fs from 'fs';
import path from 'path';
import { pool } from '../config/database.js';

async function migrate(): Promise<void> {
  // This package is CommonJS (no "type": "module"), so __dirname is available
  // natively. Using import.meta.url here would be undefined at runtime under tsx.
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
