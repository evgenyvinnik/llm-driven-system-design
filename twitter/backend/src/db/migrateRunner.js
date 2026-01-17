import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './pool.js';
import logger from '../shared/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Database Migration Runner
 *
 * Manages database schema changes with versioned migration files.
 *
 * Features:
 * - Tracks applied migrations in schema_migrations table
 * - Applies migrations in order (sorted by filename)
 * - Runs each migration in a transaction for atomicity
 * - Supports rollback via .down.sql files
 * - Logs all operations for auditability
 */

/**
 * Migration directory path
 */
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Ensure the migrations tracking table exists
 */
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255),
      applied_at TIMESTAMP DEFAULT NOW(),
      applied_by VARCHAR(100) DEFAULT current_user,
      checksum VARCHAR(64)
    )
  `);

  logger.debug('Schema migrations table ensured');
}

/**
 * Calculate a checksum for migration content
 * @param {string} content - Migration file content
 * @returns {string} MD5-like checksum
 */
function calculateChecksum(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Get list of applied migrations from the database
 * @returns {Promise<Map<string, object>>} Map of version -> migration info
 */
async function getAppliedMigrations() {
  const result = await pool.query(
    'SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version',
  );

  const migrations = new Map();
  for (const row of result.rows) {
    migrations.set(row.version, row);
  }

  return migrations;
}

/**
 * Get list of pending migration files
 * @returns {Promise<Array<object>>} Array of migration file info
 */
async function getPendingMigrations() {
  const appliedMigrations = await getAppliedMigrations();

  // Create migrations directory if it doesn't exist
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    return [];
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).sort();

  const pending = [];
  for (const file of files) {
    // Skip non-SQL files and down migrations
    if (!file.endsWith('.sql') || file.includes('.down.')) {
      continue;
    }

    // Extract version from filename (e.g., 001_initial_schema.sql -> 001)
    const version = file.split('_')[0];
    const name = file.replace('.sql', '');

    if (!appliedMigrations.has(version)) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');

      pending.push({
        version,
        name,
        file,
        filePath,
        content,
        checksum: calculateChecksum(content),
      });
    }
  }

  return pending;
}

/**
 * Apply a single migration
 * @param {object} migration - Migration info
 * @returns {Promise<void>}
 */
async function applyMigration(migration) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    logger.info({ version: migration.version, name: migration.name }, 'Applying migration');

    // Execute the migration SQL
    await client.query(migration.content);

    // Record the migration
    await client.query(
      'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, migration.checksum],
    );

    await client.query('COMMIT');

    logger.info({ version: migration.version, name: migration.name }, 'Migration applied successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(
      {
        version: migration.version,
        name: migration.name,
        error: error.message,
      },
      'Migration failed',
    );
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Rollback a single migration
 * @param {string} version - Migration version to rollback
 * @returns {Promise<boolean>} Whether rollback was successful
 */
async function rollbackMigration(version) {
  const appliedMigrations = await getAppliedMigrations();

  if (!appliedMigrations.has(version)) {
    logger.warn({ version }, 'Migration not found in applied migrations');
    return false;
  }

  const migration = appliedMigrations.get(version);

  // Look for down migration file
  const downFile = `${migration.name}.down.sql`;
  const downFilePath = path.join(MIGRATIONS_DIR, downFile);

  if (!fs.existsSync(downFilePath)) {
    logger.error({ version, downFile }, 'No down migration file found');
    throw new Error(`No rollback file found: ${downFile}`);
  }

  const downContent = fs.readFileSync(downFilePath, 'utf8');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    logger.info({ version, name: migration.name }, 'Rolling back migration');

    // Execute the down migration SQL
    await client.query(downContent);

    // Remove the migration record
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);

    await client.query('COMMIT');

    logger.info({ version, name: migration.name }, 'Migration rolled back successfully');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(
      {
        version,
        name: migration.name,
        error: error.message,
      },
      'Rollback failed',
    );
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations
 * @returns {Promise<number>} Number of migrations applied
 */
export async function migrate() {
  await ensureMigrationsTable();

  const pending = await getPendingMigrations();

  if (pending.length === 0) {
    logger.info('No pending migrations');
    return 0;
  }

  logger.info({ count: pending.length }, 'Found pending migrations');

  for (const migration of pending) {
    await applyMigration(migration);
  }

  logger.info({ count: pending.length }, 'All migrations applied successfully');
  return pending.length;
}

/**
 * Get migration status
 * @returns {Promise<object>} Status object with applied and pending migrations
 */
export async function getStatus() {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const pending = await getPendingMigrations();

  return {
    applied: Array.from(applied.values()),
    pending: pending.map((m) => ({
      version: m.version,
      name: m.name,
      file: m.file,
    })),
    total: applied.size + pending.length,
  };
}

/**
 * Verify migration checksums match
 * @returns {Promise<Array<object>>} List of migrations with checksum mismatches
 */
export async function verifyChecksums() {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const mismatches = [];

  for (const [version, migration] of applied) {
    const file = `${migration.name}.sql`;
    const filePath = path.join(MIGRATIONS_DIR, file);

    if (!fs.existsSync(filePath)) {
      mismatches.push({
        version,
        name: migration.name,
        issue: 'Migration file not found',
      });
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const currentChecksum = calculateChecksum(content);

    if (currentChecksum !== migration.checksum) {
      mismatches.push({
        version,
        name: migration.name,
        issue: 'Checksum mismatch - migration file was modified after application',
        expected: migration.checksum,
        actual: currentChecksum,
      });
    }
  }

  if (mismatches.length > 0) {
    logger.warn({ mismatches }, 'Migration checksum verification failed');
  } else {
    logger.info('All migration checksums verified');
  }

  return mismatches;
}

/**
 * Create a new migration file
 * @param {string} name - Migration name (e.g., 'add_deleted_at_column')
 * @returns {string} Path to created migration file
 */
export function createMigration(name) {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  }

  // Get next version number
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && !f.includes('.down.'));
  const maxVersion = files.reduce((max, file) => {
    const version = parseInt(file.split('_')[0], 10);
    return Math.max(max, version);
  }, 0);

  const nextVersion = String(maxVersion + 1).padStart(3, '0');
  const fileName = `${nextVersion}_${name}.sql`;
  const filePath = path.join(MIGRATIONS_DIR, fileName);

  const template = `-- Migration: ${name}
-- Version: ${nextVersion}
-- Created: ${new Date().toISOString()}

-- Add your migration SQL here

`;

  fs.writeFileSync(filePath, template);

  // Also create down migration template
  const downFileName = `${nextVersion}_${name}.down.sql`;
  const downFilePath = path.join(MIGRATIONS_DIR, downFileName);

  const downTemplate = `-- Rollback: ${name}
-- Version: ${nextVersion}

-- Add your rollback SQL here

`;

  fs.writeFileSync(downFilePath, downTemplate);

  logger.info({ file: fileName }, 'Created new migration file');

  return filePath;
}

// CLI interface
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];

  (async () => {
    try {
      switch (command) {
        case 'up':
        case 'migrate':
          const applied = await migrate();
          console.log(`Applied ${applied} migration(s)`);
          break;

        case 'status':
          const status = await getStatus();
          console.log('\nApplied migrations:');
          for (const m of status.applied) {
            console.log(`  [${m.version}] ${m.name} (${m.applied_at})`);
          }
          console.log('\nPending migrations:');
          for (const m of status.pending) {
            console.log(`  [${m.version}] ${m.name}`);
          }
          break;

        case 'verify':
          const mismatches = await verifyChecksums();
          if (mismatches.length > 0) {
            console.log('\nChecksum mismatches found:');
            for (const m of mismatches) {
              console.log(`  [${m.version}] ${m.name}: ${m.issue}`);
            }
            process.exit(1);
          } else {
            console.log('All checksums verified');
          }
          break;

        case 'create':
          const migrationName = process.argv[3];
          if (!migrationName) {
            console.error('Usage: migrate.js create <migration_name>');
            process.exit(1);
          }
          const created = createMigration(migrationName);
          console.log(`Created: ${created}`);
          break;

        case 'rollback':
          const version = process.argv[3];
          if (!version) {
            console.error('Usage: migrate.js rollback <version>');
            process.exit(1);
          }
          await rollbackMigration(version);
          console.log(`Rolled back version ${version}`);
          break;

        default:
          console.log('Usage: migrate.js <command>');
          console.log('Commands:');
          console.log('  up/migrate  - Apply pending migrations');
          console.log('  status      - Show migration status');
          console.log('  verify      - Verify migration checksums');
          console.log('  create      - Create a new migration file');
          console.log('  rollback    - Rollback a specific migration');
      }
    } catch (error) {
      console.error('Migration error:', error.message);
      process.exit(1);
    } finally {
      await pool.end();
    }
  })();
}

export default {
  migrate,
  getStatus,
  verifyChecksums,
  createMigration,
  rollbackMigration,
};
