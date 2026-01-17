/**
 * @fileoverview PostgreSQL connection pool configuration.
 *
 * Creates and exports a shared connection pool for PostgreSQL/TimescaleDB.
 * The pool manages connection lifecycle, reuse, and limits to ensure
 * efficient database access across all services.
 */

import { Pool } from 'pg';

/**
 * PostgreSQL connection pool instance.
 *
 * Configured with sensible defaults for a monitoring application:
 * - max 20 connections to handle concurrent metric ingestion and queries
 * - 30s idle timeout to release unused connections
 * - 2s connection timeout to fail fast on database issues
 *
 * Connection parameters are read from environment variables with
 * fallback to local development defaults.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'metricsdb',
  user: process.env.DB_USER || 'metrics',
  password: process.env.DB_PASSWORD || 'metrics123',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export default pool;
