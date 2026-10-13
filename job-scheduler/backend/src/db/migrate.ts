/**
 * Database migration script for the job scheduler.
 * Creates all necessary tables for jobs, executions, logs, and users.
 * Run with `npm run db:migrate` or called programmatically at startup.
 * @module db/migrate
 */

import { pool } from './pool';
import { logger } from '../utils/logger';

/** Arbitrary constant identifying the migration advisory lock across processes. */
const MIGRATION_LOCK_KEY = 4_270_115;

/**
 * SQL schema for the job scheduler database.
 * Creates tables for jobs, executions, execution logs, and users.
 * Uses PostgreSQL features like UUID generation and JSONB for payloads.
 */
const SCHEMA_SQL = `
-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table for authentication
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Jobs table: stores job definitions and scheduling information
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  handler VARCHAR(255) NOT NULL,
  payload JSONB DEFAULT '{}',
  schedule VARCHAR(100),
  next_run_time TIMESTAMP WITH TIME ZONE,
  priority INTEGER DEFAULT 50,
  max_retries INTEGER DEFAULT 3,
  initial_backoff_ms INTEGER DEFAULT 1000,
  max_backoff_ms INTEGER DEFAULT 3600000,
  timeout_ms INTEGER DEFAULT 300000,
  status VARCHAR(50) DEFAULT 'SCHEDULED',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Job executions table: tracks individual execution attempts
CREATE TABLE IF NOT EXISTS job_executions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'PENDING',
  attempt INTEGER DEFAULT 1,
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  result JSONB,
  error TEXT,
  worker_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Execution logs table: stores log entries from job handlers
CREATE TABLE IF NOT EXISTS execution_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  execution_id UUID NOT NULL REFERENCES job_executions(id) ON DELETE CASCADE,
  level VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_next_run_time ON jobs(next_run_time);
CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name);

CREATE INDEX IF NOT EXISTS idx_executions_job_id ON job_executions(job_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON job_executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_scheduled_at ON job_executions(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_executions_next_retry_at ON job_executions(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_executions_created_at ON job_executions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_logs_execution_id ON execution_logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON execution_logs(created_at);

-- ---------------------------------------------------------------------------
-- Execution queue: job_executions is both the attempt history and the work
-- queue. Workers claim PENDING rows with FOR UPDATE SKIP LOCKED, hold them
-- under a lease, and every later write is fenced on fencing_token.
-- ---------------------------------------------------------------------------

-- One global, strictly increasing sequence: each claim takes the next value,
-- so a later lease on the same execution always carries a larger token.
CREATE SEQUENCE IF NOT EXISTS execution_fencing_seq;

-- What to do when the scheduler finds a recurring job later than the grace
-- window: run the missed slot once (fire_once) or drop it (skip).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS misfire_policy VARCHAR(20) NOT NULL DEFAULT 'fire_once';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_misfire_policy_check') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_misfire_policy_check
      CHECK (misfire_policy IN ('fire_once', 'skip'));
  END IF;
END $$;

-- priority is copied from the job when the execution is created so the claim
-- query can order by it from a single index.
ALTER TABLE job_executions ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 50;
-- Earliest time a PENDING row may be claimed (now for fresh runs, now + backoff for retries).
ALTER TABLE job_executions ADD COLUMN IF NOT EXISTS run_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
-- Lease held by worker_id while RUNNING; renewed by heartbeats, reaped when it lapses.
ALTER TABLE job_executions ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE job_executions ADD COLUMN IF NOT EXISTS fencing_token BIGINT;

-- Firing guard: one row per (job, scheduled slot, attempt). Two schedulers that
-- both believe they are leader can only insert the same slot once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_job_slot_attempt
  ON job_executions(job_id, scheduled_at, attempt);
-- Claim path: only PENDING rows, in priority order, oldest first.
CREATE INDEX IF NOT EXISTS idx_executions_claimable
  ON job_executions(priority DESC, run_at) WHERE status = 'PENDING';
-- Reaper path: only RUNNING rows, by lease deadline.
CREATE INDEX IF NOT EXISTS idx_executions_lease
  ON job_executions(lease_expires_at) WHERE status = 'RUNNING';
-- Scheduler tick: only active definitions, by due time.
CREATE INDEX IF NOT EXISTS idx_jobs_due
  ON jobs(next_run_time) WHERE status = 'SCHEDULED';

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at for jobs
DROP TRIGGER IF EXISTS update_jobs_updated_at ON jobs;
CREATE TRIGGER update_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger to auto-update updated_at for users
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
`;

/**
 * Runs database migrations.
 *
 * @description Creates all necessary tables, indexes, and triggers for the job scheduler.
 * Uses IF NOT EXISTS clauses, making it safe to run multiple times (idempotent).
 * Should be called at application startup or via `npm run db:migrate`.
 *
 * @returns {Promise<void>} Resolves when migrations complete successfully
 * @throws {Error} If migration fails - error is logged and re-thrown
 *
 * @example
 * // At application startup
 * await migrate();
 * console.log('Database ready');
 *
 * @example
 * // In seed script
 * await migrate();
 * await seedSampleJobs();
 */
export async function migrate(): Promise<void> {
  logger.info('Running database migrations...');

  const client = await pool.connect();
  try {
    // `npm run dev` boots the API, the scheduler and three workers at once, and
    // each runs migrate(). Concurrent DDL (CREATE OR REPLACE FUNCTION, DROP/CREATE
    // TRIGGER, ALTER TABLE) deadlocks in PostgreSQL, which used to kill one of the
    // processes at random on startup. A session-level advisory lock serializes them;
    // every statement is idempotent, so the later runs are no-ops.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(SCHEMA_SQL);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
    logger.info('Database migrations completed successfully');
  } catch (error) {
    logger.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Rolls back the database by dropping all tables.
 *
 * @description Removes all job scheduler tables, triggers, and functions from the database.
 * This is a destructive operation that permanently deletes all data.
 *
 * WARNING: This will delete ALL job scheduler data including jobs, executions, and logs.
 * Only use in development or testing environments.
 *
 * @returns {Promise<void>} Resolves when rollback completes successfully
 * @throws {Error} If rollback fails - error is logged and re-thrown
 *
 * @example
 * // Reset database for testing
 * await rollback();
 * await migrate();
 * await seedTestData();
 */
export async function rollback(): Promise<void> {
  logger.warn('Rolling back database (dropping all tables)...');

  const client = await pool.connect();
  try {
    await client.query(`
      DROP TRIGGER IF EXISTS update_jobs_updated_at ON jobs;
      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      DROP FUNCTION IF EXISTS update_updated_at_column();
      DROP TABLE IF EXISTS execution_logs CASCADE;
      DROP TABLE IF EXISTS job_executions CASCADE;
      DROP TABLE IF EXISTS jobs CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP SEQUENCE IF EXISTS execution_fencing_seq;
    `);
    logger.info('Database rollback completed');
  } catch (error) {
    logger.error('Rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run migrations if this file is executed directly
if (require.main === module) {
  migrate()
    .then(() => {
      logger.info('Migrations complete, exiting');
      process.exit(0);
    })
    .catch(() => process.exit(1));
}
