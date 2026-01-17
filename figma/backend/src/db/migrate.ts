/**
 * Database migration runner for the Figma backend.
 * Handles schema versioning and applies migrations in order.
 * Supports both CLI and programmatic execution.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool, { query, execute, queryOne } from './postgres.js';
import { logger } from '../shared/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Represents a migration file with version and SQL content.
 */
interface Migration {
  version: number;
  file: string;
  name: string;
}

/**
 * Record of an applied migration in the database.
 */
interface MigrationRecord {
  version: number;
  applied_at: Date;
}

/**
 * Path to the migrations directory.
 */
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Parses migration files from the migrations directory.
 * Expected format: 001_migration_name.sql, 002_another_migration.sql, etc.
 * @returns Array of migrations sorted by version
 */
function getMigrations(): Migration[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.warn({ path: MIGRATIONS_DIR }, 'Migrations directory does not exist');
    return [];
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  return files.map(file => {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${file}. Expected format: 001_name.sql`);
    }

    return {
      version: parseInt(match[1], 10),
      file,
      name: match[2].replace(/_/g, ' '),
    };
  });
}

/**
 * Ensures the schema_migrations table exists.
 * Creates it if it doesn't exist.
 */
async function ensureMigrationsTable(): Promise<void> {
  await execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255),
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

/**
 * Gets all applied migrations from the database.
 * @returns Set of applied migration versions
 */
async function getAppliedMigrations(): Promise<Set<number>> {
  const rows = await query<MigrationRecord>('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(rows.map(r => r.version));
}

/**
 * Applies a single migration to the database.
 * Wraps the migration in a transaction for safety.
 * @param migration - The migration to apply
 */
async function applyMigration(migration: Migration): Promise<void> {
  const filePath = path.join(MIGRATIONS_DIR, migration.file);
  const sql = fs.readFileSync(filePath, 'utf8');

  logger.info({ version: migration.version, name: migration.name }, 'Applying migration');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
      [migration.version, migration.name]
    );
    await client.query('COMMIT');

    logger.info({ version: migration.version, name: migration.name }, 'Migration applied successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({
      version: migration.version,
      name: migration.name,
      error: error instanceof Error ? error.message : String(error),
    }, 'Migration failed');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs all pending migrations.
 * @returns Number of migrations applied
 */
export async function migrate(): Promise<number> {
  logger.info('Starting database migration');

  await ensureMigrationsTable();

  const migrations = getMigrations();
  const applied = await getAppliedMigrations();

  const pending = migrations.filter(m => !applied.has(m.version));

  if (pending.length === 0) {
    logger.info('No pending migrations');
    return 0;
  }

  logger.info({ count: pending.length }, 'Pending migrations found');

  for (const migration of pending) {
    await applyMigration(migration);
  }

  logger.info({ count: pending.length }, 'All migrations applied successfully');
  return pending.length;
}

/**
 * Gets the status of all migrations.
 * @returns Object with migration status information
 */
export async function getMigrationStatus(): Promise<{
  applied: MigrationRecord[];
  pending: Migration[];
  current: number | null;
}> {
  await ensureMigrationsTable();

  const migrations = getMigrations();
  const appliedVersions = await getAppliedMigrations();

  const appliedRows = await query<MigrationRecord>(
    'SELECT version, applied_at FROM schema_migrations ORDER BY version'
  );

  const pending = migrations.filter(m => !appliedVersions.has(m.version));
  const current = appliedRows.length > 0
    ? Math.max(...appliedRows.map(r => r.version))
    : null;

  return {
    applied: appliedRows,
    pending,
    current,
  };
}

/**
 * Rolls back the last applied migration.
 * Note: This requires a corresponding down migration file (not implemented).
 * For now, logs a warning and suggests manual rollback.
 */
export async function rollback(): Promise<void> {
  await ensureMigrationsTable();

  const lastMigration = await queryOne<MigrationRecord>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );

  if (!lastMigration) {
    logger.warn('No migrations to rollback');
    return;
  }

  logger.warn({
    version: lastMigration.version,
  }, 'Automatic rollback not implemented. Please restore from backup or manually reverse the migration.');
}

/**
 * CLI entry point for running migrations.
 */
async function main(): Promise<void> {
  const command = process.argv[2] || 'migrate';

  try {
    switch (command) {
      case 'migrate':
        await migrate();
        break;

      case 'status':
        const status = await getMigrationStatus();
        console.log('\nMigration Status:');
        console.log(`Current version: ${status.current ?? 'none'}`);
        console.log('\nApplied migrations:');
        if (status.applied.length === 0) {
          console.log('  (none)');
        } else {
          for (const m of status.applied) {
            console.log(`  ${m.version}: applied at ${m.applied_at}`);
          }
        }
        console.log('\nPending migrations:');
        if (status.pending.length === 0) {
          console.log('  (none)');
        } else {
          for (const m of status.pending) {
            console.log(`  ${m.version}: ${m.name}`);
          }
        }
        break;

      case 'rollback':
        await rollback();
        break;

      default:
        console.log(`Unknown command: ${command}`);
        console.log('Usage: npm run db:migrate [migrate|status|rollback]');
        process.exit(1);
    }
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run if executed directly
if (process.argv[1]?.includes('migrate')) {
  main().catch(console.error);
}

export default { migrate, getMigrationStatus, rollback };
