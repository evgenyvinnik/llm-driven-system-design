/**
 * Database Migration Runner
 *
 * Manages database schema migrations with version tracking.
 * Migrations are SQL files in the migrations/ directory that are
 * executed in order based on their numeric prefix.
 *
 * WHY Migration Scripts Enable Safe Schema Changes:
 * - Version tracking prevents running the same migration twice
 * - Ordered execution ensures dependencies are respected
 * - Rollback support allows recovery from failed deployments
 * - Migration history provides audit trail for schema changes
 * - Transactional migrations prevent partial schema updates
 *
 * Usage:
 *   npm run db:migrate           - Run all pending migrations
 *   npm run db:migrate:status    - Show migration status
 *   npm run db:migrate:rollback  - Rollback last migration
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================

const MIGRATIONS_DIR = join(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'schema_migrations';

// ============================================================================
// Migration Types
// ============================================================================

interface MigrationRecord {
  id: number;
  name: string;
  applied_at: Date;
  checksum: string;
}

interface MigrationFile {
  name: string;
  path: string;
  version: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate a simple checksum for migration content.
 * Used to detect if a migration file was modified after being applied.
 */
function calculateChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(16);
}

/**
 * Parse version number from migration filename.
 * Expected format: NNN_description.sql (e.g., 001_initial_schema.sql)
 */
function parseVersion(filename: string): number {
  const match = filename.match(/^(\d+)_/);
  if (!match) {
    throw new Error(`Invalid migration filename: ${filename}. Expected format: NNN_description.sql`);
  }
  return parseInt(match[1], 10);
}

/**
 * Get list of migration files sorted by version.
 */
function getMigrationFiles(): MigrationFile[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.log('No migrations directory found. Creating...');
    return [];
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => ({
      name,
      path: join(MIGRATIONS_DIR, name),
      version: parseVersion(name),
    }))
    .sort((a, b) => a.version - b.version);

  return files;
}

// ============================================================================
// Migration Runner
// ============================================================================

/**
 * Database migration runner class.
 * Manages schema migrations with version tracking and rollback support.
 */
class MigrationRunner {
  private pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString:
        connectionString ||
        process.env.DATABASE_URL ||
        'postgresql://discord:discord@localhost:5432/babydiscord',
    });
  }

  /**
   * Ensure the migrations tracking table exists.
   */
  async ensureMigrationsTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        checksum VARCHAR(32) NOT NULL
      )
    `);
  }

  /**
   * Get list of already applied migrations.
   */
  async getAppliedMigrations(): Promise<Map<string, MigrationRecord>> {
    const result = await this.pool.query<MigrationRecord>(
      `SELECT id, name, applied_at, checksum FROM ${MIGRATIONS_TABLE} ORDER BY id`
    );
    return new Map(result.rows.map((row) => [row.name, row]));
  }

  /**
   * Run all pending migrations.
   */
  async migrate(): Promise<{ applied: string[]; skipped: string[] }> {
    await this.ensureMigrationsTable();

    const applied: string[] = [];
    const skipped: string[] = [];

    const migrationFiles = getMigrationFiles();
    const appliedMigrations = await this.getAppliedMigrations();

    for (const migration of migrationFiles) {
      const existing = appliedMigrations.get(migration.name);

      if (existing) {
        // Check if migration was modified
        const content = readFileSync(migration.path, 'utf-8');
        const currentChecksum = calculateChecksum(content);

        if (existing.checksum !== currentChecksum) {
          console.warn(
            `WARNING: Migration ${migration.name} has been modified since it was applied!`
          );
          console.warn(`  Applied checksum: ${existing.checksum}`);
          console.warn(`  Current checksum: ${currentChecksum}`);
        }

        skipped.push(migration.name);
        continue;
      }

      // Apply the migration
      console.log(`Applying migration: ${migration.name}`);
      const content = readFileSync(migration.path, 'utf-8');
      const checksum = calculateChecksum(content);

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // Execute the migration SQL
        await client.query(content);

        // Record the migration
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`,
          [migration.name, checksum]
        );

        await client.query('COMMIT');
        applied.push(migration.name);
        console.log(`  Applied successfully`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`  Failed to apply migration: ${migration.name}`);
        throw error;
      } finally {
        client.release();
      }
    }

    return { applied, skipped };
  }

  /**
   * Show status of all migrations.
   */
  async status(): Promise<void> {
    await this.ensureMigrationsTable();

    const migrationFiles = getMigrationFiles();
    const appliedMigrations = await this.getAppliedMigrations();

    console.log('\nMigration Status:');
    console.log('=================\n');

    if (migrationFiles.length === 0) {
      console.log('No migration files found.\n');
      return;
    }

    for (const migration of migrationFiles) {
      const applied = appliedMigrations.get(migration.name);
      const status = applied ? 'APPLIED' : 'PENDING';
      const appliedAt = applied
        ? `(${applied.applied_at.toISOString()})`
        : '';

      console.log(`  [${status}] ${migration.name} ${appliedAt}`);
    }

    const pendingCount = migrationFiles.length - appliedMigrations.size;
    console.log(`\nTotal: ${migrationFiles.length} migrations, ${pendingCount} pending\n`);
  }

  /**
   * Rollback the last applied migration.
   * Note: This requires a corresponding down migration file (e.g., 001_initial_schema.down.sql)
   */
  async rollback(): Promise<string | null> {
    await this.ensureMigrationsTable();

    // Get the last applied migration
    const result = await this.pool.query<MigrationRecord>(
      `SELECT id, name FROM ${MIGRATIONS_TABLE} ORDER BY id DESC LIMIT 1`
    );

    if (result.rows.length === 0) {
      console.log('No migrations to rollback.');
      return null;
    }

    const lastMigration = result.rows[0];
    const downMigrationPath = join(
      MIGRATIONS_DIR,
      lastMigration.name.replace('.sql', '.down.sql')
    );

    if (!existsSync(downMigrationPath)) {
      console.error(
        `Rollback file not found: ${lastMigration.name.replace('.sql', '.down.sql')}`
      );
      console.error('Rollback aborted. Please create a down migration file or rollback manually.');
      return null;
    }

    console.log(`Rolling back: ${lastMigration.name}`);
    const downContent = readFileSync(downMigrationPath, 'utf-8');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Execute the down migration
      await client.query(downContent);

      // Remove the migration record
      await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = $1`, [
        lastMigration.id,
      ]);

      await client.query('COMMIT');
      console.log('  Rolled back successfully');
      return lastMigration.name;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`  Failed to rollback migration: ${lastMigration.name}`);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run the legacy init.sql for initial setup.
   * This is for backwards compatibility with the existing schema.
   */
  async runLegacyInit(): Promise<void> {
    const initSqlPath = join(__dirname, 'init.sql');

    if (!existsSync(initSqlPath)) {
      console.log('No init.sql found. Skipping legacy initialization.');
      return;
    }

    console.log('Running legacy init.sql...');
    const initSql = readFileSync(initSqlPath, 'utf-8');

    try {
      await this.pool.query(initSql);
      console.log('Legacy init.sql completed successfully.');
    } catch (error) {
      console.error('Failed to run init.sql:', error);
      throw error;
    }
  }

  /**
   * Close the database connection pool.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const command = process.argv[2] || 'migrate';
  const runner = new MigrationRunner();

  try {
    switch (command) {
      case 'migrate':
        // First run legacy init.sql if no migrations exist
        const appliedBefore = await runner.getAppliedMigrations();
        if (appliedBefore.size === 0) {
          await runner.runLegacyInit();
        }

        const { applied, skipped } = await runner.migrate();
        console.log('\nMigration Summary:');
        console.log(`  Applied: ${applied.length}`);
        console.log(`  Skipped: ${skipped.length}`);
        break;

      case 'status':
        await runner.status();
        break;

      case 'rollback':
        const rolledBack = await runner.rollback();
        if (rolledBack) {
          console.log(`\nRolled back: ${rolledBack}`);
        }
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.log('Usage: npm run db:migrate [migrate|status|rollback]');
        process.exit(1);
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await runner.close();
  }
}

// Export for programmatic use
export { MigrationRunner, getMigrationFiles, calculateChecksum };

// Run if called directly
main();
