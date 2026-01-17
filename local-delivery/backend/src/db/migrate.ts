/**
 * Database migration runner.
 * Executes SQL migrations in order and tracks which have been applied.
 *
 * Features:
 * - Sequential migration execution
 * - Tracks applied migrations in schema_migrations table
 * - Transaction-safe: each migration runs in a transaction
 * - Idempotent: safe to run multiple times
 *
 * Usage:
 *   npm run db:migrate
 *
 * @module db/migrate
 */
import { pool, queryOne, execute, query } from '../utils/db.js';
import { logger } from '../shared/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Migration record in the database.
 */
interface MigrationRecord {
  version: string;
  name: string;
  applied_at: Date;
}

/**
 * Ensures the schema_migrations table exists.
 */
async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(10) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Gets all applied migrations.
 */
async function getAppliedMigrations(): Promise<string[]> {
  const result = await query<MigrationRecord>(
    `SELECT version FROM schema_migrations ORDER BY version`
  );
  return result.map((r) => r.version);
}

/**
 * Gets all migration files from the migrations directory.
 */
function getMigrationFiles(): { version: string; name: string; path: string }[] {
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    logger.warn({ dir: migrationsDir }, 'Migrations directory does not exist');
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((file) => {
    const match = file.match(/^(\d{3})_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${file}. Expected format: 001_description.sql`);
    }
    return {
      version: match[1],
      name: match[2],
      path: path.join(migrationsDir, file),
    };
  });
}

/**
 * Runs a single migration within a transaction.
 */
async function runMigration(
  version: string,
  name: string,
  sqlPath: string
): Promise<void> {
  const client = await pool.connect();
  const sql = fs.readFileSync(sqlPath, 'utf8');

  try {
    await client.query('BEGIN');

    // Execute the migration SQL
    await client.query(sql);

    // Record the migration
    await client.query(
      `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
      [version, name]
    );

    await client.query('COMMIT');
    logger.info({ version, name }, 'Migration applied successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ version, name, error: (error as Error).message }, 'Migration failed');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs all pending migrations.
 */
export async function runMigrations(): Promise<void> {
  logger.info('Starting database migrations');

  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const migrations = getMigrationFiles();

  const pending = migrations.filter((m) => !applied.includes(m.version));

  if (pending.length === 0) {
    logger.info('No pending migrations');
    return;
  }

  logger.info({ count: pending.length }, 'Pending migrations found');

  for (const migration of pending) {
    logger.info({ version: migration.version, name: migration.name }, 'Applying migration');
    await runMigration(migration.version, migration.name, migration.path);
  }

  logger.info('All migrations applied successfully');
}

/**
 * Shows migration status.
 */
export async function getMigrationStatus(): Promise<{
  applied: MigrationRecord[];
  pending: { version: string; name: string }[];
}> {
  await ensureMigrationsTable();

  const appliedVersions = await getAppliedMigrations();
  const applied = await query<MigrationRecord>(
    `SELECT * FROM schema_migrations ORDER BY version`
  );
  const migrations = getMigrationFiles();
  const pending = migrations.filter((m) => !appliedVersions.includes(m.version));

  return { applied, pending };
}

// Run migrations if executed directly
if (process.argv[1] === __filename) {
  runMigrations()
    .then(() => {
      logger.info('Migration runner completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error: (error as Error).message }, 'Migration runner failed');
      process.exit(1);
    });
}

export default {
  runMigrations,
  getMigrationStatus,
};
