import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import config from '../../shared/config/index.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Database Migration Runner
 *
 * Manages schema migrations with tracking table and transaction safety.
 * Supports both up and down migrations for rollback capability.
 *
 * Usage:
 *   node src/db/migrate.js up      # Run pending migrations
 *   node src/db/migrate.js down    # Rollback last migration
 *   node src/db/migrate.js status  # Show migration status
 */

class MigrationRunner {
  constructor() {
    this.pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
    });
    this.migrationsDir = path.join(__dirname, '../../database/migrations');
  }

  async connect() {
    try {
      await this.pool.query('SELECT NOW()');
      console.log('Connected to PostgreSQL');
    } catch (error) {
      console.error('Failed to connect to PostgreSQL:', error.message);
      throw error;
    }
  }

  async ensureMigrationsTable() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        rolled_back_at TIMESTAMP WITH TIME ZONE
      )
    `);
  }

  async getAppliedMigrations() {
    const result = await this.pool.query(
      'SELECT version, filename, applied_at FROM schema_migrations WHERE rolled_back_at IS NULL ORDER BY version'
    );
    return result.rows;
  }

  getMigrationFiles() {
    if (!fs.existsSync(this.migrationsDir)) {
      console.log(`Migrations directory not found: ${this.migrationsDir}`);
      return [];
    }

    return fs
      .readdirSync(this.migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  }

  parseVersion(filename) {
    const match = filename.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  async runUp() {
    await this.ensureMigrationsTable();
    const applied = await this.getAppliedMigrations();
    const appliedVersions = new Set(applied.map((r) => r.version));
    const files = this.getMigrationFiles();

    let ranCount = 0;
    for (const file of files) {
      const version = this.parseVersion(file);
      if (!version || appliedVersions.has(version)) continue;

      console.log(`\nApplying migration: ${file}`);
      const sql = fs.readFileSync(path.join(this.migrationsDir, file), 'utf8');

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)',
          [version, file]
        );
        await client.query('COMMIT');
        console.log(`Applied: ${file}`);
        ranCount++;
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to apply ${file}:`, error.message);
        throw error;
      } finally {
        client.release();
      }
    }

    if (ranCount === 0) {
      console.log('\nNo pending migrations.');
    } else {
      console.log(`\nApplied ${ranCount} migration(s).`);
    }
  }

  async runDown() {
    await this.ensureMigrationsTable();
    const applied = await this.getAppliedMigrations();

    if (applied.length === 0) {
      console.log('No migrations to roll back.');
      return;
    }

    const lastMigration = applied[applied.length - 1];
    const downFile = lastMigration.filename.replace('.sql', '.down.sql');
    const downPath = path.join(this.migrationsDir, downFile);

    if (!fs.existsSync(downPath)) {
      console.error(`No down migration found: ${downFile}`);
      console.log('Create a down migration file or manually roll back.');
      return;
    }

    console.log(`\nRolling back: ${lastMigration.filename}`);
    const sql = fs.readFileSync(downPath, 'utf8');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'UPDATE schema_migrations SET rolled_back_at = NOW() WHERE version = $1',
        [lastMigration.version]
      );
      await client.query('COMMIT');
      console.log(`Rolled back: ${lastMigration.filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed to roll back ${lastMigration.filename}:`, error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  async showStatus() {
    await this.ensureMigrationsTable();
    const applied = await this.getAppliedMigrations();
    const appliedVersions = new Set(applied.map((r) => r.version));
    const files = this.getMigrationFiles();

    console.log('\nMigration Status:');
    console.log('─'.repeat(60));

    for (const file of files) {
      const version = this.parseVersion(file);
      const status = appliedVersions.has(version) ? '✓ Applied' : '○ Pending';
      const appliedInfo = applied.find((r) => r.version === version);
      const date = appliedInfo ? new Date(appliedInfo.applied_at).toISOString() : '';
      console.log(`${status.padEnd(12)} ${file}${date ? ` (${date})` : ''}`);
    }

    console.log('─'.repeat(60));
    console.log(`Total: ${files.length} migrations, ${applied.length} applied`);
  }

  async close() {
    await this.pool.end();
  }
}

async function main() {
  const command = process.argv[2] || 'up';
  const runner = new MigrationRunner();

  try {
    await runner.connect();

    switch (command) {
      case 'up':
        await runner.runUp();
        break;
      case 'down':
        await runner.runDown();
        break;
      case 'status':
        await runner.showStatus();
        break;
      default:
        console.log('Usage: node migrate.js [up|down|status]');
        process.exit(1);
    }
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await runner.close();
  }
}

main();
