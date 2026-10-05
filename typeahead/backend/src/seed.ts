/**
 * Seed script to populate the typeahead database with sample phrases.
 * Run with: npm run seed
 *
 * The data lives in db-seed/seed.sql, the single source of seed data (the screenshot
 * harness runs the same file with psql). Re-running resets the seeded tables.
 */

import { readFile } from 'fs/promises';
import pg from 'pg';

const SEED_FILE = new URL('../db-seed/seed.sql', import.meta.url);

const pgPool = new pg.Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'typeahead',
  password: process.env.PG_PASSWORD || 'typeahead_password',
  database: process.env.PG_DATABASE || 'typeahead',
});

async function seed(): Promise<void> {
  console.log('Seeding database from db-seed/seed.sql...');

  try {
    const sql = await readFile(SEED_FILE, 'utf8');

    // A query without parameters runs every statement in the file (it has its own BEGIN/COMMIT)
    await pgPool.query(sql);

    // Verify
    const result = await pgPool.query('SELECT COUNT(*) as count FROM phrase_counts');
    console.log(`Total phrases in database: ${result.rows[0].count}`);

    console.log('Seeding complete!');
  } catch (error) {
    console.error('Seeding error:', error);
    process.exitCode = 1;
  } finally {
    await pgPool.end();
  }
}

seed();
