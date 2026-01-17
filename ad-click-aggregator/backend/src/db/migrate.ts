/**
 * @fileoverview Database migration runner.
 * Executes SQL migrations in order, tracks applied migrations,
 * and supports dry-run mode for safe deployment.
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../shared/logger.js';

// Get the migrations directory relative to this file
// Uses process.cwd() as base and navigates to the migrations folder
const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations');

/**
 * Migration record stored in schema_migrations table
 */
interface MigrationRecord {
  version: string;
  name: string;
  applied_at: Date;
  checksum: string;
}

/**
 * Migration file metadata
 */
interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

/**
 * Creates a simple checksum for migration content
 */
function createChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Reads all migration files from the migrations directory
 */
async function getMigrationFiles(): Promise<MigrationFile[]> {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.warn({ dir: MIGRATIONS_DIR }, 'Migrations directory does not exist');
    return [];
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const migrations: MigrationFile[] = [];

  for (const filename of files) {
    const match = filename.match(/^(\d{3})_(.+)\.sql$/);
    if (!match) {
      logger.warn({ filename }, 'Skipping file with invalid naming pattern');
      continue;
    }

    const [, version, name] = match;
    const filepath = path.join(MIGRATIONS_DIR, filename);
    const sql = fs.readFileSync(filepath, 'utf-8');
    const checksum = createChecksum(sql);

    migrations.push({
      version,
      name,
      filename,
      sql,
      checksum,
    });
  }

  return migrations;
}

/**
 * Ensures the schema_migrations table exists
 */
async function ensureMigrationTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(10) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      checksum VARCHAR(16) NOT NULL
    )
  `);
}

/**
 * Gets list of applied migrations
 */
async function getAppliedMigrations(pool: Pool): Promise<MigrationRecord[]> {
  const result = await pool.query<MigrationRecord>(`
    SELECT version, name, applied_at, checksum
    FROM schema_migrations
    ORDER BY version ASC
  `);
  return result.rows;
}

/**
 * Applies a single migration within a transaction
 */
async function applyMigration(
  pool: Pool,
  migration: MigrationFile,
  dryRun: boolean
): Promise<void> {
  const log = logger.child({ migration: migration.filename });

  if (dryRun) {
    log.info('DRY RUN: Would apply migration');
    log.debug({ sql: migration.sql.substring(0, 500) }, 'Migration SQL preview');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Execute migration SQL
    await client.query(migration.sql);

    // Record migration
    await client.query(
      `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
      [migration.version, migration.name, migration.checksum]
    );

    await client.query('COMMIT');
    log.info('Migration applied successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    log.error({ error }, 'Migration failed, rolled back');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Rolls back a migration (if down migration exists)
 */
async function rollbackMigration(
  pool: Pool,
  version: string,
  dryRun: boolean
): Promise<boolean> {
  const downFile = fs.readdirSync(MIGRATIONS_DIR)
    .find(f => f.startsWith(`${version}_`) && f.endsWith('.down.sql'));

  if (!downFile) {
    logger.warn({ version }, 'No down migration found');
    return false;
  }

  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, downFile), 'utf-8');
  const log = logger.child({ migration: downFile });

  if (dryRun) {
    log.info('DRY RUN: Would rollback migration');
    return true;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    await client.query('COMMIT');
    log.info('Migration rolled back successfully');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    log.error({ error }, 'Rollback failed');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Main migration runner options
 */
interface MigrateOptions {
  dryRun?: boolean;
  targetVersion?: string;
}

/**
 * Runs pending migrations
 */
export async function migrate(options: MigrateOptions = {}): Promise<{
  applied: string[];
  pending: string[];
  errors: string[];
}> {
  const { dryRun = false, targetVersion } = options;
  const log = logger.child({ dryRun, targetVersion });

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'adclick_aggregator',
    user: process.env.POSTGRES_USER || 'adclick',
    password: process.env.POSTGRES_PASSWORD || 'adclick123',
  });

  const result = {
    applied: [] as string[],
    pending: [] as string[],
    errors: [] as string[],
  };

  try {
    await ensureMigrationTable(pool);

    const applied = await getAppliedMigrations(pool);
    const appliedVersions = new Set(applied.map(m => m.version));

    const migrations = await getMigrationFiles();
    const pending = migrations.filter(m => !appliedVersions.has(m.version));

    // Check for checksum mismatches
    for (const appliedMigration of applied) {
      const file = migrations.find(m => m.version === appliedMigration.version);
      if (file && file.checksum !== appliedMigration.checksum) {
        const msg = `Checksum mismatch for migration ${appliedMigration.version}`;
        log.error({ version: appliedMigration.version }, msg);
        result.errors.push(msg);
      }
    }

    if (result.errors.length > 0) {
      return result;
    }

    result.pending = pending.map(m => m.filename);

    // Apply pending migrations
    for (const migration of pending) {
      if (targetVersion && migration.version > targetVersion) {
        log.info({ version: migration.version }, 'Stopping at target version');
        break;
      }

      try {
        await applyMigration(pool, migration, dryRun);
        result.applied.push(migration.filename);
      } catch (error) {
        result.errors.push(`Failed to apply ${migration.filename}: ${error}`);
        break; // Stop on first error
      }
    }

    if (pending.length === 0) {
      log.info('Database is up to date');
    } else if (!dryRun) {
      log.info({ count: result.applied.length }, 'Migrations applied');
    }

    return result;
  } finally {
    await pool.end();
  }
}

/**
 * Rolls back to a specific version
 */
export async function rollback(
  targetVersion: string,
  dryRun = false
): Promise<{ rolledBack: string[]; errors: string[] }> {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'adclick_aggregator',
    user: process.env.POSTGRES_USER || 'adclick',
    password: process.env.POSTGRES_PASSWORD || 'adclick123',
  });

  const result = {
    rolledBack: [] as string[],
    errors: [] as string[],
  };

  try {
    const applied = await getAppliedMigrations(pool);
    const toRollback = applied
      .filter(m => m.version > targetVersion)
      .sort((a, b) => b.version.localeCompare(a.version)); // Reverse order

    for (const migration of toRollback) {
      const success = await rollbackMigration(pool, migration.version, dryRun);
      if (success) {
        result.rolledBack.push(migration.version);
      } else {
        result.errors.push(`No down migration for ${migration.version}`);
      }
    }

    return result;
  } finally {
    await pool.end();
  }
}

/**
 * Gets migration status
 */
export async function status(): Promise<{
  applied: MigrationRecord[];
  pending: MigrationFile[];
}> {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'adclick_aggregator',
    user: process.env.POSTGRES_USER || 'adclick',
    password: process.env.POSTGRES_PASSWORD || 'adclick123',
  });

  try {
    await ensureMigrationTable(pool);

    const applied = await getAppliedMigrations(pool);
    const appliedVersions = new Set(applied.map(m => m.version));

    const migrations = await getMigrationFiles();
    const pending = migrations.filter(m => !appliedVersions.has(m.version));

    return { applied, pending };
  } finally {
    await pool.end();
  }
}

// CLI entrypoint - runs when this file is executed directly
// Check if this is the main module using require.main (works in both ESM and CJS)
const isMainModule = typeof require !== 'undefined' && require.main === module;

// For ESM compatibility, also check if invoked via tsx
const isTsxMain = process.argv[1]?.includes('migrate');

if (isMainModule || isTsxMain) {
  const args = process.argv.slice(2);
  const command = args[0] || 'migrate';
  const dryRun = args.includes('--dry-run');

  (async () => {
    try {
      switch (command) {
        case 'migrate': {
          const migrateResult = await migrate({ dryRun });
          console.log('Applied:', migrateResult.applied);
          console.log('Pending:', migrateResult.pending);
          if (migrateResult.errors.length > 0) {
            console.error('Errors:', migrateResult.errors);
            process.exit(1);
          }
          break;
        }

        case 'status': {
          const statusResult = await status();
          console.log('Applied migrations:');
          for (const m of statusResult.applied) {
            console.log(`  ${m.version}_${m.name} (${m.applied_at.toISOString()})`);
          }
          console.log('Pending migrations:');
          for (const m of statusResult.pending) {
            console.log(`  ${m.filename}`);
          }
          break;
        }

        case 'rollback': {
          const targetVersion = args[1];
          if (!targetVersion) {
            console.error('Usage: migrate.ts rollback <version> [--dry-run]');
            process.exit(1);
          }
          const rollbackResult = await rollback(targetVersion, dryRun);
          console.log('Rolled back:', rollbackResult.rolledBack);
          if (rollbackResult.errors.length > 0) {
            console.error('Errors:', rollbackResult.errors);
          }
          break;
        }

        default:
          console.log('Usage: migrate.ts [migrate|status|rollback] [--dry-run]');
      }
    } catch (error) {
      console.error('Migration error:', error);
      process.exit(1);
    }
  })();
}
