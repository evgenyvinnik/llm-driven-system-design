import pg from 'pg';
import dotenv from 'dotenv';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

/**
 * Database migration runner with version tracking.
 *
 * Features:
 * - Tracks applied migrations in schema_migrations table
 * - Supports dry-run mode for previewing changes
 * - Provides status command to show pending migrations
 * - Handles rollback scripts (if available)
 *
 * Usage:
 *   npm run db:migrate              - Apply pending migrations
 *   npm run db:migrate:dry-run      - Preview migrations without applying
 *   npm run db:migrate:status       - Show migration status
 *   npm run db:migrate:rollback     - Rollback last migration
 */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://reddit:reddit_password@localhost:5432/reddit',
});

const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW(),
      checksum VARCHAR(64)
    )
  `);
}

async function getAppliedMigrations() {
  const result = await pool.query(
    'SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version'
  );
  return new Map(result.rows.map(r => [r.version, r]));
}

function getMigrationFiles() {
  try {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql') && !f.includes('.rollback.'))
      .sort();
    return files;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No migrations directory found. Creating...');
      return [];
    }
    throw error;
  }
}

function calculateChecksum(content) {
  // Simple checksum for detecting modified migrations
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

async function migrate(dryRun = false) {
  console.log(dryRun ? '[DRY RUN] Checking migrations...' : 'Running migrations...');
  console.log('');

  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const files = getMigrationFiles();

  let appliedCount = 0;

  for (const file of files) {
    const version = file.replace('.sql', '');

    if (applied.has(version)) {
      // Check for modified migration (warning only)
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      const checksum = calculateChecksum(sql);
      if (applied.get(version).checksum !== checksum) {
        console.warn(`  WARNING: ${file} has been modified since it was applied!`);
      }
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    const checksum = calculateChecksum(sql);

    if (dryRun) {
      console.log(`  Would apply: ${file}`);
      console.log('  ---');
      // Show first 500 chars of SQL
      console.log(sql.substring(0, 500) + (sql.length > 500 ? '\n  ...(truncated)' : ''));
      console.log('');
    } else {
      console.log(`  Applying: ${file}`);
      const start = Date.now();

      try {
        await pool.query(sql);
        await pool.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [version, checksum]
        );
        console.log(`  Applied in ${Date.now() - start}ms`);
      } catch (error) {
        console.error(`  FAILED: ${error.message}`);
        console.error('');
        console.error('  Migration aborted. Fix the error and retry.');
        console.error('  No further migrations will be applied.');
        process.exit(1);
      }
    }

    appliedCount++;
  }

  if (appliedCount === 0) {
    console.log('  No pending migrations.');
  } else if (dryRun) {
    console.log(`  ${appliedCount} migration(s) would be applied.`);
  } else {
    console.log('');
    console.log(`  Successfully applied ${appliedCount} migration(s).`);
  }
}

async function status() {
  console.log('Migration status:');
  console.log('');

  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const files = getMigrationFiles();

  for (const file of files) {
    const version = file.replace('.sql', '');
    const migration = applied.get(version);

    if (migration) {
      const date = new Date(migration.applied_at).toISOString().split('T')[0];
      console.log(`  [APPLIED] ${file} (${date})`);
    } else {
      console.log(`  [PENDING] ${file}`);
    }
  }

  const pending = files.filter(f => !applied.has(f.replace('.sql', '')));
  console.log('');
  console.log(`  ${applied.size} applied, ${pending.length} pending`);
}

async function rollback() {
  console.log('Rolling back last migration...');
  console.log('');

  await ensureMigrationsTable();

  const result = await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );

  if (result.rows.length === 0) {
    console.log('  No migrations to rollback.');
    return;
  }

  const version = result.rows[0].version;
  const rollbackFile = `${version}.rollback.sql`;
  const rollbackPath = join(MIGRATIONS_DIR, rollbackFile);

  try {
    const sql = readFileSync(rollbackPath, 'utf-8');
    console.log(`  Rolling back: ${version}`);

    await pool.query(sql);
    await pool.query('DELETE FROM schema_migrations WHERE version = $1', [version]);

    console.log('  Rollback complete.');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`  No rollback script found: ${rollbackFile}`);
      console.error('  Create a rollback script or manually revert the migration.');
    } else {
      console.error(`  Rollback failed: ${error.message}`);
    }
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'migrate';

async function run() {
  try {
    switch (command) {
      case 'migrate':
        await migrate(false);
        break;
      case 'dry-run':
      case '--dry-run':
        await migrate(true);
        break;
      case 'status':
        await status();
        break;
      case 'rollback':
        await rollback();
        break;
      default:
        console.log('Usage: npm run db:migrate [command]');
        console.log('');
        console.log('Commands:');
        console.log('  (default)   Apply pending migrations');
        console.log('  dry-run     Preview migrations without applying');
        console.log('  status      Show migration status');
        console.log('  rollback    Rollback last migration');
        process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

run().then(() => process.exit(0)).catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
