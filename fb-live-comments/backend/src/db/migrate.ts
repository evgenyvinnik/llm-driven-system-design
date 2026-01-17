/**
 * Database Migration Script
 *
 * Runs the initial SQL schema to set up all required tables for the live comments system.
 * This is a one-time setup script that creates users, streams, comments, reactions, and bans tables.
 *
 * @module db/migrate
 */

import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

/** PostgreSQL connection pool for migration execution */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/live_comments',
});

/**
 * Executes the database migration by reading and running init.sql.
 * Exits the process with code 1 on failure, 0 on success.
 */
async function migrate() {
  console.log('Running database migrations...');

  try {
    const sql = readFileSync(join(__dirname, 'init.sql'), 'utf8');
    await pool.query(sql);
    console.log('Migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
