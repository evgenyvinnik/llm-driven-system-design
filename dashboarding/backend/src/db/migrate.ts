/**
 * @fileoverview Database migration script for TimescaleDB schema setup.
 *
 * This module creates all necessary tables, indexes, and hypertables for
 * the metrics monitoring system. It enables TimescaleDB extension and sets up:
 * - User authentication tables
 * - Metric definitions and time-series data storage
 * - Hourly and daily rollup tables for efficient historical queries
 * - Dashboard and panel configuration
 * - Alert rules and instances
 *
 * Run with: npm run db:migrate
 */

import pool from './pool.js';

/**
 * Array of SQL migration statements to be executed in order.
 * Each statement is idempotent (uses IF NOT EXISTS) for safe re-runs.
 */
const migrations = [
  // Enable TimescaleDB extension
  `CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;`,

  // Users table
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(255) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );`,

  // Metric definitions (metadata)
  `CREATE TABLE IF NOT EXISTS metric_definitions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    tags JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, tags)
  );`,

  // Create index for metric lookups
  `CREATE INDEX IF NOT EXISTS idx_metric_defs_name ON metric_definitions (name);`,
  `CREATE INDEX IF NOT EXISTS idx_metric_defs_tags ON metric_definitions USING GIN (tags);`,

  // Metrics table (raw time-series data)
  `CREATE TABLE IF NOT EXISTS metrics (
    time TIMESTAMPTZ NOT NULL,
    metric_id INTEGER NOT NULL REFERENCES metric_definitions(id),
    value DOUBLE PRECISION NOT NULL
  );`,

  // Convert to hypertable
  `SELECT create_hypertable('metrics', 'time', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 day');`,

  // Index for fast queries
  `CREATE INDEX IF NOT EXISTS idx_metrics_id_time ON metrics (metric_id, time DESC);`,

  // Hourly rollups table
  `CREATE TABLE IF NOT EXISTS metrics_hourly (
    time TIMESTAMPTZ NOT NULL,
    metric_id INTEGER NOT NULL,
    min_value DOUBLE PRECISION,
    max_value DOUBLE PRECISION,
    avg_value DOUBLE PRECISION,
    count INTEGER,
    PRIMARY KEY (metric_id, time)
  );`,

  // Daily rollups table
  `CREATE TABLE IF NOT EXISTS metrics_daily (
    time TIMESTAMPTZ NOT NULL,
    metric_id INTEGER NOT NULL,
    min_value DOUBLE PRECISION,
    max_value DOUBLE PRECISION,
    avg_value DOUBLE PRECISION,
    count INTEGER,
    PRIMARY KEY (metric_id, time)
  );`,

  // Dashboards table
  `CREATE TABLE IF NOT EXISTS dashboards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    layout JSONB NOT NULL DEFAULT '{"columns": 12, "rows": 8}',
    is_public BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );`,

  // Panels table
  `CREATE TABLE IF NOT EXISTS panels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    title VARCHAR(255),
    panel_type VARCHAR(50) NOT NULL,
    query JSONB NOT NULL,
    position JSONB NOT NULL,
    options JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );`,

  // Alert rules table
  `CREATE TABLE IF NOT EXISTS alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    metric_name VARCHAR(255) NOT NULL,
    tags JSONB NOT NULL DEFAULT '{}',
    condition JSONB NOT NULL,
    window_seconds INTEGER NOT NULL DEFAULT 300,
    severity VARCHAR(50) NOT NULL DEFAULT 'warning',
    notifications JSONB NOT NULL DEFAULT '[]',
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );`,

  // Alert instances table (active/historical alerts)
  `CREATE TABLE IF NOT EXISTS alert_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    fired_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    notification_sent BOOLEAN DEFAULT false
  );`,

  // Index for alert lookup
  `CREATE INDEX IF NOT EXISTS idx_alert_instances_rule_status
   ON alert_instances (rule_id, status);`,
];

/**
 * Executes all database migrations sequentially.
 *
 * Acquires a single database connection and runs each migration statement
 * in order. If any migration fails, the error is logged and re-thrown.
 * The connection pool is properly closed after migration completes.
 *
 * @returns Promise that resolves when all migrations complete successfully
 * @throws Error if any migration statement fails
 */
async function migrate() {
  console.log('Running database migrations...');
  const client = await pool.connect();

  try {
    for (const migration of migrations) {
      console.log(`Executing: ${migration.substring(0, 60)}...`);
      await client.query(migration);
    }
    console.log('All migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
