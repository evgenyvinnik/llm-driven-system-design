/**
 * Database migration runner
 * Applies pending migrations in order and tracks applied versions
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/youtube_topk',
});

/**
 * Run all pending migrations
 */
async function migrate() {
  console.log('Starting database migration...');

  try {
    // Create migrations tracking table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Get list of applied migrations
    const appliedResult = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedVersions = new Set(appliedResult.rows.map((r) => r.version));

    console.log(`Found ${appliedVersions.size} previously applied migrations`);

    // Read migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    console.log(`Found ${files.length} migration files`);

    let appliedCount = 0;

    for (const file of files) {
      // Extract version number from filename (e.g., "001_initial_schema.sql" -> 1)
      const match = file.match(/^(\d+)_/);
      if (!match) {
        console.warn(`Skipping file with invalid name format: ${file}`);
        continue;
      }

      const version = parseInt(match[1], 10);

      // Skip if already applied
      if (appliedVersions.has(version)) {
        console.log(`  [SKIP] Migration ${version} (${file}) - already applied`);
        continue;
      }

      console.log(`  [APPLY] Migration ${version}: ${file}`);

      // Read and execute migration
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      // Use a transaction for each migration
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Execute the migration SQL
        await client.query(sql);

        // Record the migration
        await client.query(
          'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)',
          [version, file]
        );

        await client.query('COMMIT');
        console.log(`    Migration ${version} applied successfully`);
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`    Migration ${version} FAILED:`, err.message);
        throw err;
      } finally {
        client.release();
      }
    }

    if (appliedCount === 0) {
      console.log('\nNo new migrations to apply. Database is up to date.');
    } else {
      console.log(`\nSuccessfully applied ${appliedCount} migration(s).`);
    }
  } finally {
    await pool.end();
  }
}

/**
 * Show migration status
 */
async function status() {
  console.log('Migration Status\n');

  try {
    // Check if migrations table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'schema_migrations'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.log('No migrations have been run yet.\n');
      return;
    }

    // Get applied migrations
    const appliedResult = await pool.query(
      'SELECT version, filename, applied_at FROM schema_migrations ORDER BY version'
    );

    if (appliedResult.rows.length === 0) {
      console.log('No migrations have been applied.\n');
    } else {
      console.log('Applied migrations:');
      for (const row of appliedResult.rows) {
        const date = new Date(row.applied_at).toISOString();
        console.log(`  [${row.version}] ${row.filename} (applied: ${date})`);
      }
    }

    // Get pending migrations
    const appliedVersions = new Set(appliedResult.rows.map((r) => r.version));
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    const pending = files.filter((file) => {
      const match = file.match(/^(\d+)_/);
      if (!match) return false;
      return !appliedVersions.has(parseInt(match[1], 10));
    });

    if (pending.length > 0) {
      console.log('\nPending migrations:');
      for (const file of pending) {
        console.log(`  [ ] ${file}`);
      }
    } else {
      console.log('\nAll migrations have been applied.');
    }
  } finally {
    await pool.end();
  }
}

/**
 * Rollback the last migration (if rollback file exists)
 */
async function rollback() {
  console.log('Rolling back last migration...\n');

  try {
    // Get the last applied migration
    const lastResult = await pool.query(
      'SELECT version, filename FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );

    if (lastResult.rows.length === 0) {
      console.log('No migrations to rollback.');
      return;
    }

    const { version, filename } = lastResult.rows[0];
    console.log(`Last migration: ${version} (${filename})`);

    // Check for rollback file
    const rollbackFilename = filename.replace('.sql', '.rollback.sql');
    const rollbackPath = path.join(__dirname, 'rollbacks', rollbackFilename);

    if (!fs.existsSync(rollbackPath)) {
      console.error(`\nNo rollback file found: ${rollbackFilename}`);
      console.error('Manual rollback required.');
      return;
    }

    console.log(`Found rollback file: ${rollbackFilename}`);

    // Execute rollback
    const sql = fs.readFileSync(rollbackPath, 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
      await client.query('COMMIT');
      console.log(`\nSuccessfully rolled back migration ${version}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Rollback FAILED:', err.message);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// CLI handling
const command = process.argv[2] || 'migrate';

switch (command) {
  case 'migrate':
  case 'up':
    migrate().catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
    break;
  case 'status':
    status().catch((err) => {
      console.error('Status check failed:', err);
      process.exit(1);
    });
    break;
  case 'rollback':
  case 'down':
    rollback().catch((err) => {
      console.error('Rollback failed:', err);
      process.exit(1);
    });
    break;
  default:
    console.log('Usage: node migrate.js [migrate|status|rollback]');
    process.exit(1);
}
