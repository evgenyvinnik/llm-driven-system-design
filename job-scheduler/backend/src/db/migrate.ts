/**
 * Database migration module for the job scheduler.
 * Handles schema creation and versioning to ensure the database structure
 * matches the application requirements. Migrations are idempotent and tracked
 * in a migrations table.
 * @module db/migrate
 */

import { pool } from './pool';
import { logger } from '../utils/logger';

/**
 * Migration definitions containing up and down SQL scripts.
 * Each migration is applied in order and tracked to prevent re-application.
 */
const migrations = [
  {
    name: '001_initial_schema',
    up: `
      -- Create extension for UUID generation
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      -- Job status enum
      CREATE TYPE job_status AS ENUM (
        'SCHEDULED',
        'QUEUED',
        'RUNNING',
        'PAUSED',
        'COMPLETED',
        'FAILED'
      );

      -- Execution status enum
      CREATE TYPE execution_status AS ENUM (
        'PENDING',
        'RUNNING',
        'COMPLETED',
        'FAILED',
        'PENDING_RETRY',
        'CANCELLED',
        'DEDUPLICATED'
      );

      -- Jobs table
      CREATE TABLE jobs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        handler VARCHAR(255) NOT NULL,
        payload JSONB DEFAULT '{}',
        schedule VARCHAR(100),
        next_run_time TIMESTAMP WITH TIME ZONE,
        priority INTEGER DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),
        max_retries INTEGER DEFAULT 3 CHECK (max_retries >= 0),
        initial_backoff_ms INTEGER DEFAULT 1000 CHECK (initial_backoff_ms > 0),
        max_backoff_ms INTEGER DEFAULT 3600000 CHECK (max_backoff_ms > 0),
        timeout_ms INTEGER DEFAULT 300000 CHECK (timeout_ms > 0),
        status job_status DEFAULT 'SCHEDULED',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Job dependencies table
      CREATE TABLE job_dependencies (
        job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
        depends_on_job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
        PRIMARY KEY (job_id, depends_on_job_id),
        CHECK (job_id != depends_on_job_id)
      );

      -- Job executions table
      CREATE TABLE job_executions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
        status execution_status NOT NULL DEFAULT 'PENDING',
        attempt INTEGER DEFAULT 1 CHECK (attempt > 0),
        scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
        started_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        next_retry_at TIMESTAMP WITH TIME ZONE,
        result JSONB,
        error TEXT,
        worker_id VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Execution logs table
      CREATE TABLE execution_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        execution_id UUID REFERENCES job_executions(id) ON DELETE CASCADE,
        level VARCHAR(10) NOT NULL CHECK (level IN ('info', 'warn', 'error')),
        message TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Migrations table
      CREATE TABLE IF NOT EXISTS migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Indexes for performance
      CREATE INDEX idx_jobs_next_run_time ON jobs(next_run_time)
        WHERE status = 'SCHEDULED';
      CREATE INDEX idx_jobs_status ON jobs(status);
      CREATE INDEX idx_jobs_name ON jobs(name);
      CREATE INDEX idx_executions_job_id ON job_executions(job_id);
      CREATE INDEX idx_executions_status ON job_executions(status);
      CREATE INDEX idx_executions_scheduled_at ON job_executions(scheduled_at);
      CREATE INDEX idx_executions_worker_id ON job_executions(worker_id);
      CREATE INDEX idx_execution_logs_execution_id ON execution_logs(execution_id);

      -- Function to update updated_at timestamp
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ language 'plpgsql';

      -- Trigger for jobs updated_at
      CREATE TRIGGER update_jobs_updated_at
        BEFORE UPDATE ON jobs
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    `,
    down: `
      DROP TRIGGER IF EXISTS update_jobs_updated_at ON jobs;
      DROP FUNCTION IF EXISTS update_updated_at_column;
      DROP TABLE IF EXISTS execution_logs;
      DROP TABLE IF EXISTS job_executions;
      DROP TABLE IF EXISTS job_dependencies;
      DROP TABLE IF EXISTS jobs;
      DROP TYPE IF EXISTS execution_status;
      DROP TYPE IF EXISTS job_status;
    `,
  },
];

/**
 * Retrieves the set of already-applied migration names.
 * Queries the migrations table to determine which migrations have been run.
 * @returns Set of migration names that have been applied
 */
async function getMigrationStatus(): Promise<Set<string>> {
  try {
    const result = await pool.query('SELECT name FROM migrations');
    return new Set(result.rows.map((row: { name: string }) => row.name));
  } catch {
    // Table doesn't exist yet
    return new Set();
  }
}

/**
 * Applies all pending database migrations.
 * Runs each migration in a transaction for atomicity. Skips already-applied
 * migrations based on the migrations tracking table.
 * Called automatically on service startup.
 * @throws Re-throws any migration errors after logging
 */
export async function migrate(): Promise<void> {
  logger.info('Starting database migrations...');

  const appliedMigrations = await getMigrationStatus();

  for (const migration of migrations) {
    if (appliedMigrations.has(migration.name)) {
      logger.info(`Migration ${migration.name} already applied, skipping`);
      continue;
    }

    logger.info(`Applying migration: ${migration.name}`);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(migration.up);
      await client.query(
        'INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [migration.name]
      );
      await client.query('COMMIT');
      logger.info(`Migration ${migration.name} applied successfully`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Migration ${migration.name} failed`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  logger.info('All migrations completed');
}

/**
 * Rolls back one or more migrations.
 * Executes the down script for the specified migration or the most recent one.
 * Useful for development and testing; use with caution in production.
 * @param migrationName - Optional specific migration to rollback; defaults to latest
 * @throws Re-throws any rollback errors after logging
 */
export async function rollback(migrationName?: string): Promise<void> {
  const client = await pool.connect();
  const targetMigrations = migrationName
    ? migrations.filter((m) => m.name === migrationName)
    : [migrations[migrations.length - 1]];

  for (const migration of targetMigrations) {
    logger.info(`Rolling back migration: ${migration.name}`);

    try {
      await client.query('BEGIN');
      await client.query(migration.down);
      await client.query('DELETE FROM migrations WHERE name = $1', [migration.name]);
      await client.query('COMMIT');
      logger.info(`Migration ${migration.name} rolled back successfully`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Rollback of ${migration.name} failed`, error);
      throw error;
    }
  }

  client.release();
}

/**
 * CLI entry point for running migrations directly.
 * Allows running `npx ts-node src/db/migrate.ts` to apply migrations.
 */
// Run migrations if executed directly
if (require.main === module) {
  require('dotenv').config();

  migrate()
    .then(() => {
      logger.info('Migrations completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Migration failed', error);
      process.exit(1);
    });
}
