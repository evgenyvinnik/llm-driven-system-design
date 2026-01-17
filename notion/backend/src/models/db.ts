/**
 * @fileoverview PostgreSQL database connection pool configuration.
 * Provides a shared connection pool for all database operations.
 * The pool manages connection lifecycle and automatic reconnection.
 */

import pg from 'pg';

const { Pool } = pg;

/**
 * PostgreSQL connection pool for the application.
 * Configured with sensible defaults for connection limits and timeouts.
 * Uses environment variables for flexible deployment configuration.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'notion',
  password: process.env.DB_PASSWORD || 'notion_password',
  database: process.env.DB_NAME || 'notion_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Log successful connections for debugging
pool.on('connect', () => {
  console.log('Database connected');
});

// Log connection errors without crashing
pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

export default pool;
