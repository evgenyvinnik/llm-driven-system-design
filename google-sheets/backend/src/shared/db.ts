import pg from 'pg';

const { Pool } = pg;

/**
 * PostgreSQL connection pool for the spreadsheet application.
 * Provides efficient connection reuse across multiple database operations.
 * Connections are automatically managed and released back to the pool.
 *
 * Environment variables:
 * - PGHOST: Database host (default: localhost)
 * - PGPORT: Database port (default: 5432)
 * - PGDATABASE: Database name (default: sheets)
 * - PGUSER: Database user (default: sheets)
 * - PGPASSWORD: Database password (default: sheets123)
 */
export const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'sheets',
  user: process.env.PGUSER || 'sheets',
  password: process.env.PGPASSWORD || 'sheets123',
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});
