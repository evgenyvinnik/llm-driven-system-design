/**
 * Database migration runner with version tracking
 *
 * Features:
 * - Tracks applied migrations in a migrations table
 * - Supports both up and down migrations
 * - Prevents re-running applied migrations
 * - Provides status, migrate, and rollback commands
 */
import { pool, query } from '../utils/db.js';
import { logger } from '../shared/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = logger.child({ component: 'migrations' });
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Ensure the migrations tracking table exists
 */
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

/**
 * Get list of applied migrations
 */
async function getAppliedMigrations() {
  const result = await pool.query(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
  );
  return result.rows;
}

/**
 * Get list of migration files from filesystem
 */
async function getMigrationFiles() {
  try {
    const files = await fs.readdir(MIGRATIONS_DIR);
    return files
      .filter(f => f.endsWith('.sql'))
      .sort()
      .map(filename => {
        const match = filename.match(/^(\d+)_(.+)\.sql$/);
        if (!match) return null;
        return {
          version: match[1],
          name: match[2],
          filename,
          filepath: path.join(MIGRATIONS_DIR, filename)
        };
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Read migration file content
 */
async function readMigration(filepath) {
  const content = await fs.readFile(filepath, 'utf-8');

  // Split into up and down sections if markers exist
  const upMatch = content.match(/-- UP\n([\s\S]*?)(?=-- DOWN|$)/);
  const downMatch = content.match(/-- DOWN\n([\s\S]*?)$/);

  if (upMatch) {
    return {
      up: upMatch[1].trim(),
      down: downMatch ? downMatch[1].trim() : null
    };
  }

  // No markers, entire file is the up migration
  return { up: content.trim(), down: null };
}

/**
 * Apply a single migration
 */
async function applyMigration(migration, direction = 'up') {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { up, down } = await readMigration(migration.filepath);
    const sql = direction === 'up' ? up : down;

    if (!sql) {
      throw new Error(`No ${direction} migration found for ${migration.filename}`);
    }

    // Execute migration
    await client.query(sql);

    if (direction === 'up') {
      // Record migration
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name]
      );
    } else {
      // Remove migration record
      await client.query(
        'DELETE FROM schema_migrations WHERE version = $1',
        [migration.version]
      );
    }

    await client.query('COMMIT');

    log.info({
      version: migration.version,
      name: migration.name,
      direction
    }, `Migration ${direction === 'up' ? 'applied' : 'rolled back'}`);

    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations
 */
export async function migrate() {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const appliedVersions = new Set(applied.map(m => m.version));

  const allMigrations = await getMigrationFiles();
  const pending = allMigrations.filter(m => !appliedVersions.has(m.version));

  if (pending.length === 0) {
    log.info('No pending migrations');
    return { applied: 0, migrations: [] };
  }

  log.info({ count: pending.length }, 'Running pending migrations');

  const results = [];
  for (const migration of pending) {
    await applyMigration(migration, 'up');
    results.push(migration);
  }

  return { applied: results.length, migrations: results };
}

/**
 * Rollback the last migration
 */
export async function rollback(steps = 1) {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();

  if (applied.length === 0) {
    log.info('No migrations to rollback');
    return { rolledBack: 0, migrations: [] };
  }

  const toRollback = applied.slice(-steps).reverse();
  const allMigrations = await getMigrationFiles();
  const migrationMap = new Map(allMigrations.map(m => [m.version, m]));

  const results = [];
  for (const record of toRollback) {
    const migration = migrationMap.get(record.version);
    if (!migration) {
      log.warn({ version: record.version }, 'Migration file not found, skipping');
      continue;
    }

    const { down } = await readMigration(migration.filepath);
    if (!down) {
      log.warn({ version: record.version }, 'No down migration, cannot rollback');
      continue;
    }

    await applyMigration(migration, 'down');
    results.push(migration);
  }

  return { rolledBack: results.length, migrations: results };
}

/**
 * Get migration status
 */
export async function status() {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const appliedVersions = new Set(applied.map(m => m.version));

  const allMigrations = await getMigrationFiles();

  const status = allMigrations.map(m => ({
    version: m.version,
    name: m.name,
    status: appliedVersions.has(m.version) ? 'applied' : 'pending',
    appliedAt: applied.find(a => a.version === m.version)?.applied_at
  }));

  return {
    applied: applied.length,
    pending: allMigrations.length - applied.length,
    total: allMigrations.length,
    migrations: status
  };
}

/**
 * Create a new migration file
 */
export async function create(name) {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = `${timestamp}_${name.replace(/\s+/g, '_').toLowerCase()}.sql`;
  const filepath = path.join(MIGRATIONS_DIR, filename);

  const template = `-- Migration: ${name}
-- Created: ${new Date().toISOString()}

-- UP
-- Add your migration SQL here


-- DOWN
-- Add your rollback SQL here

`;

  await fs.mkdir(MIGRATIONS_DIR, { recursive: true });
  await fs.writeFile(filepath, template);

  log.info({ filename }, 'Created new migration file');
  return { filename, filepath };
}

// CLI interface
const command = process.argv[2];

async function main() {
  try {
    switch (command) {
      case 'migrate':
      case 'up':
        const migrateResult = await migrate();
        console.log(`Applied ${migrateResult.applied} migration(s)`);
        break;

      case 'rollback':
      case 'down':
        const steps = parseInt(process.argv[3]) || 1;
        const rollbackResult = await rollback(steps);
        console.log(`Rolled back ${rollbackResult.rolledBack} migration(s)`);
        break;

      case 'status':
        const statusResult = await status();
        console.log('\nMigration Status:');
        console.log(`  Applied: ${statusResult.applied}`);
        console.log(`  Pending: ${statusResult.pending}`);
        console.log(`  Total:   ${statusResult.total}\n`);
        console.log('Migrations:');
        for (const m of statusResult.migrations) {
          const indicator = m.status === 'applied' ? '[x]' : '[ ]';
          const date = m.appliedAt ? ` (${m.appliedAt.toISOString()})` : '';
          console.log(`  ${indicator} ${m.version}_${m.name}${date}`);
        }
        break;

      case 'create':
        const name = process.argv.slice(3).join(' ');
        if (!name) {
          console.error('Usage: node migrate.js create <migration_name>');
          process.exit(1);
        }
        const createResult = await create(name);
        console.log(`Created: ${createResult.filename}`);
        break;

      default:
        console.log(`
Strava Database Migration Tool

Commands:
  migrate, up       Run all pending migrations
  rollback, down    Rollback the last migration (or specify number)
  status            Show migration status
  create <name>     Create a new migration file

Examples:
  node src/db/migrate.js migrate
  node src/db/migrate.js rollback 2
  node src/db/migrate.js create add_user_preferences
`);
    }
  } catch (error) {
    console.error('Migration error:', error.message);
    if (process.env.NODE_ENV !== 'production') {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

export default { migrate, rollback, status, create };
