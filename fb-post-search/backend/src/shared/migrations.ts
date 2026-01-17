/**
 * @fileoverview Enhanced database migration runner with tracking.
 * Manages schema migrations with version tracking, rollback support,
 * and status reporting. Follows a file-based migration pattern.
 */

import { pool } from '../config/database.js';
import { logger } from './logger.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Migration record stored in the database.
 */
export interface MigrationRecord {
  id: number;
  name: string;
  applied_at: Date;
  checksum: string;
}

/**
 * Migration file definition.
 */
export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  upSql: string;
  downSql?: string;
}

/**
 * Migration result status.
 */
export interface MigrationResult {
  success: boolean;
  migrationsRun: string[];
  migrationsSkipped: string[];
  errors: string[];
}

/**
 * Creates the migrations tracking table if it doesn't exist.
 */
async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      checksum VARCHAR(64) NOT NULL
    )
  `);
}

/**
 * Generates a simple checksum for migration content.
 * @param content - Migration SQL content
 * @returns Hex string checksum
 */
function generateChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Gets all applied migrations from the database.
 * @returns Array of applied migration records
 */
export async function getAppliedMigrations(): Promise<MigrationRecord[]> {
  await ensureMigrationsTable();

  const result = await pool.query<MigrationRecord>(
    'SELECT id, name, applied_at, checksum FROM schema_migrations ORDER BY id'
  );

  return result.rows;
}

/**
 * Parses a migration file to extract up and down SQL.
 * Expected format:
 * ```sql
 * -- Migration: 001_create_users.sql
 * -- Rollback: DROP TABLE users;
 *
 * CREATE TABLE users (...);
 * ```
 * @param content - File content
 * @returns Object with up and optional down SQL
 */
function parseMigrationFile(content: string): { upSql: string; downSql?: string } {
  // Look for rollback comment
  const rollbackMatch = content.match(/--\s*Rollback:\s*(.+?)(?:\n|$)/i);
  const downSql = rollbackMatch ? rollbackMatch[1].trim() : undefined;

  // Remove rollback comment from up SQL
  const upSql = content
    .replace(/--\s*Rollback:.*$/gim, '')
    .replace(/--\s*Migration:.*$/gim, '')
    .trim();

  return { upSql, downSql };
}

/**
 * Discovers migration files from the migrations directory.
 * @param migrationsDir - Path to migrations directory
 * @returns Array of migration files sorted by version
 */
export function discoverMigrations(migrationsDir: string): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) {
    logger.warn({ migrationsDir }, 'Migrations directory does not exist');
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((filename) => {
    const match = filename.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${filename}. Expected format: 001_description.sql`);
    }

    const version = parseInt(match[1], 10);
    const name = match[2];
    const filePath = path.join(migrationsDir, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { upSql, downSql } = parseMigrationFile(content);

    return {
      version,
      name: filename,
      filename,
      upSql,
      downSql,
    };
  });
}

/**
 * Runs all pending migrations.
 * @param migrationsDir - Path to migrations directory
 * @returns Migration result with details
 */
export async function runMigrations(migrationsDir: string): Promise<MigrationResult> {
  await ensureMigrationsTable();

  const result: MigrationResult = {
    success: true,
    migrationsRun: [],
    migrationsSkipped: [],
    errors: [],
  };

  const appliedMigrations = await getAppliedMigrations();
  const appliedNames = new Set(appliedMigrations.map((m) => m.name));

  const migrations = discoverMigrations(migrationsDir);

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) {
      result.migrationsSkipped.push(migration.name);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      logger.info({ migration: migration.name }, 'Running migration');

      // Execute migration
      await client.query(migration.upSql);

      // Record migration
      const checksum = generateChecksum(migration.upSql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [migration.name, checksum]
      );

      await client.query('COMMIT');

      result.migrationsRun.push(migration.name);
      logger.info({ migration: migration.name }, 'Migration completed successfully');
    } catch (error) {
      await client.query('ROLLBACK');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`${migration.name}: ${errorMessage}`);
      result.success = false;

      logger.error(
        { migration: migration.name, error },
        'Migration failed'
      );

      // Stop on first error
      break;
    } finally {
      client.release();
    }
  }

  return result;
}

/**
 * Rolls back the last applied migration.
 * @param migrationsDir - Path to migrations directory
 * @returns True if rollback succeeded
 */
export async function rollbackLastMigration(migrationsDir: string): Promise<boolean> {
  const appliedMigrations = await getAppliedMigrations();

  if (appliedMigrations.length === 0) {
    logger.warn('No migrations to rollback');
    return false;
  }

  const lastMigration = appliedMigrations[appliedMigrations.length - 1];
  const migrations = discoverMigrations(migrationsDir);
  const migrationFile = migrations.find((m) => m.name === lastMigration.name);

  if (!migrationFile) {
    logger.error(
      { migration: lastMigration.name },
      'Migration file not found for rollback'
    );
    return false;
  }

  if (!migrationFile.downSql) {
    logger.error(
      { migration: lastMigration.name },
      'No rollback SQL defined for migration'
    );
    return false;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    logger.info({ migration: lastMigration.name }, 'Rolling back migration');

    // Execute rollback
    await client.query(migrationFile.downSql);

    // Remove migration record
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [lastMigration.name]);

    await client.query('COMMIT');

    logger.info({ migration: lastMigration.name }, 'Rollback completed successfully');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ migration: lastMigration.name, error }, 'Rollback failed');
    return false;
  } finally {
    client.release();
  }
}

/**
 * Gets the current migration status.
 * @param migrationsDir - Path to migrations directory
 * @returns Status object with applied and pending migrations
 */
export async function getMigrationStatus(migrationsDir: string): Promise<{
  applied: MigrationRecord[];
  pending: string[];
  current: string | null;
}> {
  const applied = await getAppliedMigrations();
  const appliedNames = new Set(applied.map((m) => m.name));

  const allMigrations = discoverMigrations(migrationsDir);
  const pending = allMigrations
    .filter((m) => !appliedNames.has(m.name))
    .map((m) => m.name);

  return {
    applied,
    pending,
    current: applied.length > 0 ? applied[applied.length - 1].name : null,
  };
}

/**
 * Verifies migration checksums match the files.
 * Detects if migration files have been modified after application.
 * @param migrationsDir - Path to migrations directory
 * @returns Array of migrations with checksum mismatches
 */
export async function verifyMigrationChecksums(
  migrationsDir: string
): Promise<string[]> {
  const applied = await getAppliedMigrations();
  const migrations = discoverMigrations(migrationsDir);
  const migrationMap = new Map(migrations.map((m) => [m.name, m]));

  const mismatches: string[] = [];

  for (const record of applied) {
    const file = migrationMap.get(record.name);
    if (file) {
      const currentChecksum = generateChecksum(file.upSql);
      if (currentChecksum !== record.checksum) {
        mismatches.push(record.name);
        logger.warn(
          { migration: record.name },
          'Migration file has been modified after application'
        );
      }
    }
  }

  return mismatches;
}
