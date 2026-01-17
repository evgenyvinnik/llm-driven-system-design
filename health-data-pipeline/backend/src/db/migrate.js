import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, db } from '../config/database.js';
import { logger } from '../shared/logger.js';

/**
 * Database migration runner.
 *
 * WHY: Proper migration management enables:
 * - Version-controlled schema changes
 * - Safe rollout of database updates
 * - Reproducible deployments across environments
 * - Rollback capability when issues occur
 *
 * Migration strategy:
 * - Sequential numbered files (001_*.sql, 002_*.sql)
 * - Applied in order, tracked in schema_migrations table
 * - Each migration wrapped in a transaction
 * - Never modify deployed migrations - create new ones
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Ensure the schema_migrations table exists.
 */
async function ensureMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW(),
      checksum VARCHAR(64)
    )
  `);
}

/**
 * Get list of applied migrations.
 */
async function getAppliedMigrations() {
  const result = await db.query(
    'SELECT version, name FROM schema_migrations ORDER BY version'
  );
  return new Map(result.rows.map(r => [r.version, r.name]));
}

/**
 * Get list of pending migration files.
 */
async function getMigrationFiles() {
  try {
    const files = await fs.readdir(MIGRATIONS_DIR);
    return files
      .filter(f => f.endsWith('.sql'))
      .sort((a, b) => {
        const numA = parseInt(a.split('_')[0], 10);
        const numB = parseInt(b.split('_')[0], 10);
        return numA - numB;
      });
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn({ msg: 'Migrations directory not found', path: MIGRATIONS_DIR });
      return [];
    }
    throw error;
  }
}

/**
 * Parse migration file to extract UP and DOWN sections.
 */
function parseMigration(content) {
  // Look for -- DOWN marker
  const downMarker = content.indexOf('-- DOWN');

  if (downMarker === -1) {
    return { up: content.trim(), down: null };
  }

  return {
    up: content.substring(0, downMarker).replace('-- UP', '').trim(),
    down: content.substring(downMarker).replace('-- DOWN', '').trim()
  };
}

/**
 * Calculate checksum of migration content.
 */
function calculateChecksum(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Run all pending migrations.
 */
export async function runMigrations() {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();

  const pending = [];
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (!applied.has(version)) {
      pending.push({ version, file });
    }
  }

  if (pending.length === 0) {
    logger.info({ msg: 'No pending migrations' });
    return { applied: 0, total: applied.size };
  }

  logger.info({
    msg: 'Running migrations',
    pending: pending.length,
    applied: applied.size
  });

  let migrationsApplied = 0;

  for (const { version, file } of pending) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const content = await fs.readFile(filePath, 'utf8');
    const { up } = parseMigration(content);
    const checksum = calculateChecksum(up);

    logger.info({ msg: `Applying migration: ${file}`, version });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Execute the migration
      await client.query(up);

      // Record the migration
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [version, file, checksum]
      );

      await client.query('COMMIT');
      migrationsApplied++;
      logger.info({ msg: `Migration applied: ${file}`, version });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({
        msg: `Migration failed: ${file}`,
        version,
        error: error.message
      });
      throw new Error(`Migration ${file} failed: ${error.message}`);
    } finally {
      client.release();
    }
  }

  logger.info({
    msg: 'Migrations completed',
    applied: migrationsApplied,
    total: applied.size + migrationsApplied
  });

  return { applied: migrationsApplied, total: applied.size + migrationsApplied };
}

/**
 * Rollback the last migration.
 * Only works if the migration has a DOWN section.
 */
export async function rollbackMigration() {
  await ensureMigrationsTable();

  const result = await db.query(
    'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );

  if (result.rows.length === 0) {
    logger.info({ msg: 'No migrations to rollback' });
    return { rolledBack: false };
  }

  const { version, name } = result.rows[0];
  const filePath = path.join(MIGRATIONS_DIR, name);

  try {
    const content = await fs.readFile(filePath, 'utf8');
    const { down } = parseMigration(content);

    if (!down) {
      throw new Error(`Migration ${name} has no DOWN section`);
    }

    logger.info({ msg: `Rolling back migration: ${name}`, version });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(down);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);

      await client.query('COMMIT');
      logger.info({ msg: `Rollback completed: ${name}`, version });
      return { rolledBack: true, version, name };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error({
      msg: `Rollback failed: ${name}`,
      version,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get migration status.
 */
export async function getMigrationStatus() {
  await ensureMigrationsTable();

  const applied = await db.query(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
  );

  const files = await getMigrationFiles();
  const appliedVersions = new Set(applied.rows.map(r => r.version));

  const pending = files
    .filter(f => {
      const version = parseInt(f.split('_')[0], 10);
      return !appliedVersions.has(version);
    })
    .map(f => ({
      version: parseInt(f.split('_')[0], 10),
      name: f,
      status: 'pending'
    }));

  return {
    applied: applied.rows.map(r => ({
      ...r,
      status: 'applied'
    })),
    pending,
    current: applied.rows.length > 0 ? applied.rows[applied.rows.length - 1].version : 0
  };
}

/**
 * CLI entry point.
 */
export async function cli(args) {
  const command = args[0] || 'status';

  try {
    switch (command) {
      case 'up':
      case 'migrate':
        const result = await runMigrations();
        console.log(`Applied ${result.applied} migration(s). Total: ${result.total}`);
        break;

      case 'down':
      case 'rollback':
        const rollback = await rollbackMigration();
        if (rollback.rolledBack) {
          console.log(`Rolled back migration ${rollback.name}`);
        } else {
          console.log('No migrations to rollback');
        }
        break;

      case 'status':
        const status = await getMigrationStatus();
        console.log('\nApplied migrations:');
        for (const m of status.applied) {
          console.log(`  [${m.version}] ${m.name} (${m.applied_at})`);
        }
        console.log('\nPending migrations:');
        for (const m of status.pending) {
          console.log(`  [${m.version}] ${m.name}`);
        }
        console.log(`\nCurrent version: ${status.current}`);
        break;

      default:
        console.log('Usage: node migrate.js [up|down|status]');
    }
  } catch (error) {
    console.error('Migration error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run CLI if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2));
}

export default { runMigrations, rollbackMigration, getMigrationStatus };
