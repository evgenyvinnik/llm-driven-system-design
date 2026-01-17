import { pool } from './index.js';
import { logger } from '../shared/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Database migration record.
 */
interface Migration {
  version: string;
  name: string;
  appliedAt: Date;
}

/**
 * Migration file info.
 */
interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
}

/**
 * Migration runner for PostgreSQL.
 * Handles schema versioning and applies migrations in order.
 *
 * Migration files should be named: XXX_description.sql
 * Where XXX is a zero-padded version number (001, 002, etc.)
 *
 * Each migration file should contain SQL statements to execute.
 * Rollback statements can be included as comments:
 *   -- DOWN
 *   -- DROP TABLE foo;
 */
export class MigrationRunner {
  private migrationsDir: string;

  constructor(migrationsDir?: string) {
    this.migrationsDir = migrationsDir || path.join(__dirname, 'migrations');
  }

  /**
   * Ensures the schema_migrations table exists.
   */
  private async ensureMigrationsTable(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
  }

  /**
   * Gets all applied migrations from the database.
   */
  private async getAppliedMigrations(): Promise<Set<string>> {
    const result = await pool.query<Migration>(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    return new Set(result.rows.map((row) => row.version));
  }

  /**
   * Gets all migration files from the migrations directory.
   */
  private getMigrationFiles(): MigrationFile[] {
    if (!fs.existsSync(this.migrationsDir)) {
      logger.warn({ dir: this.migrationsDir }, 'Migrations directory does not exist');
      return [];
    }

    const files = fs.readdirSync(this.migrationsDir);
    const migrations: MigrationFile[] = [];

    for (const file of files) {
      if (!file.endsWith('.sql')) continue;

      // Parse version and name from filename (e.g., 001_initial_schema.sql)
      const match = file.match(/^(\d+)_(.+)\.sql$/);
      if (!match) {
        logger.warn({ file }, 'Invalid migration filename format');
        continue;
      }

      migrations.push({
        version: match[1],
        name: match[2],
        filePath: path.join(this.migrationsDir, file),
      });
    }

    // Sort by version
    return migrations.sort((a, b) => a.version.localeCompare(b.version));
  }

  /**
   * Applies a single migration.
   */
  private async applyMigration(migration: MigrationFile): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Read migration file
      const sql = fs.readFileSync(migration.filePath, 'utf-8');

      // Extract UP section (everything before -- DOWN or the whole file)
      const upSql = sql.split('-- DOWN')[0];

      // Execute the migration
      await client.query(upSql);

      // Record the migration
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name]
      );

      await client.query('COMMIT');

      logger.info(
        { version: migration.version, name: migration.name },
        'Applied migration'
      );
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(
        { error, version: migration.version, name: migration.name },
        'Failed to apply migration'
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs all pending migrations.
   */
  async migrate(): Promise<{ applied: string[]; pending: string[] }> {
    await this.ensureMigrationsTable();

    const appliedMigrations = await this.getAppliedMigrations();
    const migrationFiles = this.getMigrationFiles();

    const pending: MigrationFile[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of migrationFiles) {
      if (appliedMigrations.has(migration.version)) {
        alreadyApplied.push(migration.version);
      } else {
        pending.push(migration);
      }
    }

    if (pending.length === 0) {
      logger.info('No pending migrations');
      return { applied: [], pending: [] };
    }

    logger.info({ count: pending.length }, 'Running pending migrations');

    const applied: string[] = [];

    for (const migration of pending) {
      await this.applyMigration(migration);
      applied.push(migration.version);
    }

    return {
      applied,
      pending: pending.map((m) => m.version),
    };
  }

  /**
   * Gets migration status.
   */
  async status(): Promise<{
    applied: Array<{ version: string; name: string; appliedAt: Date }>;
    pending: Array<{ version: string; name: string }>;
  }> {
    await this.ensureMigrationsTable();

    const appliedResult = await pool.query<Migration>(
      'SELECT version, name, applied_at as "appliedAt" FROM schema_migrations ORDER BY version'
    );

    const appliedVersions = new Set(appliedResult.rows.map((r) => r.version));
    const migrationFiles = this.getMigrationFiles();

    const pending = migrationFiles
      .filter((m) => !appliedVersions.has(m.version))
      .map((m) => ({ version: m.version, name: m.name }));

    return {
      applied: appliedResult.rows,
      pending,
    };
  }

  /**
   * Rollback the last applied migration.
   * Requires the migration file to have a -- DOWN section.
   */
  async rollback(steps: number = 1): Promise<string[]> {
    const appliedResult = await pool.query<Migration>(
      'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT $1',
      [steps]
    );

    if (appliedResult.rows.length === 0) {
      logger.info('No migrations to rollback');
      return [];
    }

    const rolledBack: string[] = [];
    const migrationFiles = this.getMigrationFiles();
    const fileMap = new Map(migrationFiles.map((m) => [m.version, m]));

    for (const applied of appliedResult.rows) {
      const migration = fileMap.get(applied.version);
      if (!migration) {
        logger.warn(
          { version: applied.version },
          'Migration file not found for rollback'
        );
        continue;
      }

      const sql = fs.readFileSync(migration.filePath, 'utf-8');
      const downMatch = sql.split('-- DOWN');

      if (downMatch.length < 2) {
        logger.warn(
          { version: applied.version },
          'No DOWN section found in migration file'
        );
        continue;
      }

      // Extract DOWN SQL (remove comment markers)
      const downSql = downMatch[1]
        .split('\n')
        .map((line) => line.replace(/^-- ?/, ''))
        .join('\n');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(downSql);
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [
          applied.version,
        ]);
        await client.query('COMMIT');

        logger.info(
          { version: applied.version, name: applied.name },
          'Rolled back migration'
        );
        rolledBack.push(applied.version);
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(
          { error, version: applied.version },
          'Failed to rollback migration'
        );
        throw error;
      } finally {
        client.release();
      }
    }

    return rolledBack;
  }
}

/**
 * Singleton migration runner instance.
 */
export const migrationRunner = new MigrationRunner();

/**
 * CLI entry point for running migrations.
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'migrate';

  try {
    switch (command) {
      case 'migrate': {
        const result = await migrationRunner.migrate();
        console.log('Applied migrations:', result.applied);
        break;
      }
      case 'status': {
        const status = await migrationRunner.status();
        console.log('\nApplied migrations:');
        for (const m of status.applied) {
          console.log(`  ${m.version} - ${m.name} (${m.appliedAt})`);
        }
        console.log('\nPending migrations:');
        for (const m of status.pending) {
          console.log(`  ${m.version} - ${m.name}`);
        }
        break;
      }
      case 'rollback': {
        const steps = parseInt(args[1]) || 1;
        const rolledBack = await migrationRunner.rollback(steps);
        console.log('Rolled back migrations:', rolledBack);
        break;
      }
      default:
        console.log('Usage: npm run db:migrate [migrate|status|rollback]');
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run if executed directly
if (process.argv[1]?.endsWith('migrate.ts')) {
  main();
}

export default migrationRunner;
