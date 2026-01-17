import { pool } from './index.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../shared/logger.js';

/**
 * Database migration runner.
 * Applies SQL migrations in order, tracking which have been applied.
 * Supports up (apply) and down (rollback) migrations.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates the schema_migrations table if it doesn't exist.
 * This table tracks which migrations have been applied.
 */
async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

/**
 * Gets the list of applied migration versions.
 */
async function getAppliedMigrations(): Promise<Set<number>> {
  const { rows } = await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  return new Set(rows.map((r) => r.version));
}

/**
 * Gets all migration files from the migrations directory.
 * Migration files should be named: NNN_description.sql
 * Down migrations should be named: NNN_description.down.sql
 */
function getMigrationFiles(direction: 'up' | 'down' = 'up'): string[] {
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    logger.warn('Migrations directory does not exist');
    return [];
  }

  const files = fs.readdirSync(migrationsDir);

  if (direction === 'up') {
    // Get .sql files that are NOT .down.sql
    return files
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();
  } else {
    // Get .down.sql files
    return files.filter((f) => f.endsWith('.down.sql')).sort().reverse();
  }
}

/**
 * Extracts the version number from a migration filename.
 * @param filename - Migration filename (e.g., "001_initial.sql")
 * @returns Version number
 */
function getVersionFromFilename(filename: string): number {
  const match = filename.match(/^(\d+)_/);
  if (!match) {
    throw new Error(`Invalid migration filename: ${filename}`);
  }
  return parseInt(match[1], 10);
}

/**
 * Applies pending migrations.
 * @param targetVersion - Optional version to migrate to (applies all if not specified)
 */
export async function migrateUp(targetVersion?: number): Promise<void> {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const migrationFiles = getMigrationFiles('up');
  const migrationsDir = path.join(__dirname, 'migrations');

  let appliedCount = 0;

  for (const file of migrationFiles) {
    const version = getVersionFromFilename(file);

    if (applied.has(version)) {
      continue;
    }

    if (targetVersion !== undefined && version > targetVersion) {
      break;
    }

    logger.info({ file, version }, 'Applying migration');

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    await pool.query('BEGIN');

    try {
      await pool.query(sql);
      await pool.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [version, file]
      );
      await pool.query('COMMIT');

      logger.info({ file, version }, 'Migration applied successfully');
      appliedCount++;
    } catch (error) {
      await pool.query('ROLLBACK');
      logger.error({ error, file, version }, 'Migration failed');
      throw error;
    }
  }

  if (appliedCount === 0) {
    logger.info('No pending migrations');
  } else {
    logger.info({ appliedCount }, 'Migrations completed');
  }
}

/**
 * Rolls back migrations.
 * @param targetVersion - Version to roll back to (rolls back one if not specified)
 */
export async function migrateDown(targetVersion?: number): Promise<void> {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const migrationFiles = getMigrationFiles('down');
  const migrationsDir = path.join(__dirname, 'migrations');

  if (applied.size === 0) {
    logger.info('No migrations to roll back');
    return;
  }

  let rolledBackCount = 0;

  for (const file of migrationFiles) {
    // Extract version from down file (e.g., "001_initial.down.sql" -> 1)
    const version = getVersionFromFilename(file);

    if (!applied.has(version)) {
      continue;
    }

    if (targetVersion !== undefined && version <= targetVersion) {
      break;
    }

    logger.info({ file, version }, 'Rolling back migration');

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    await pool.query('BEGIN');

    try {
      await pool.query(sql);
      await pool.query('DELETE FROM schema_migrations WHERE version = $1', [
        version,
      ]);
      await pool.query('COMMIT');

      logger.info({ file, version }, 'Rollback completed successfully');
      rolledBackCount++;

      // Only roll back one if no target specified
      if (targetVersion === undefined) {
        break;
      }
    } catch (error) {
      await pool.query('ROLLBACK');
      logger.error({ error, file, version }, 'Rollback failed');
      throw error;
    }
  }

  if (rolledBackCount === 0) {
    logger.info('No migrations rolled back');
  } else {
    logger.info({ rolledBackCount }, 'Rollbacks completed');
  }
}

/**
 * Gets the current migration status.
 */
export async function getMigrationStatus(): Promise<{
  applied: Array<{ version: number; name: string; applied_at: Date }>;
  pending: string[];
}> {
  await ensureMigrationsTable();

  const { rows: appliedRows } = await pool.query(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
  );

  const applied = new Set(appliedRows.map((r) => r.version));
  const migrationFiles = getMigrationFiles('up');

  const pending = migrationFiles.filter(
    (f) => !applied.has(getVersionFromFilename(f))
  );

  return {
    applied: appliedRows,
    pending,
  };
}

/**
 * CLI entry point for running migrations.
 */
async function main(): Promise<void> {
  const command = process.argv[2] || 'up';
  const targetVersion = process.argv[3]
    ? parseInt(process.argv[3], 10)
    : undefined;

  try {
    switch (command) {
      case 'up':
        await migrateUp(targetVersion);
        break;
      case 'down':
        await migrateDown(targetVersion);
        break;
      case 'status':
        const status = await getMigrationStatus();
        console.log('\nApplied migrations:');
        status.applied.forEach((m) =>
          console.log(`  [${m.version}] ${m.name} (${m.applied_at})`)
        );
        console.log('\nPending migrations:');
        status.pending.forEach((f) => console.log(`  ${f}`));
        break;
      default:
        console.log('Usage: npm run db:migrate [up|down|status] [version]');
    }
  } catch (error) {
    logger.error({ error }, 'Migration error');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (process.argv[1]?.includes('migrate')) {
  main();
}
