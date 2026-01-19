/**
 * Database migration script for the job scheduler.
 * Creates all necessary tables for jobs, executions, logs, and users.
 * Run with `npm run db:migrate` or called programmatically at startup.
 * @module db/migrate
 */

import { pool } from './pool';
import { logger } from '../utils/logger';

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
 * Creates all necessary tables, indexes, and triggers.
 * Safe to run multiple times (uses IF NOT EXISTS).
 * @returns Promise that resolves when migrations complete
 */
export async function migrate(): Promise<void> {
  logger.info('Running database migrations...');

  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
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
 * WARNING: This will delete all data. Use only in development.
 * @returns Promise that resolves when rollback completes
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
