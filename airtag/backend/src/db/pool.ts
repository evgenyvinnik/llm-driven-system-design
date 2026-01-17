import { Pool } from 'pg';

/**
 * PostgreSQL connection pool for the Find My backend.
 * Provides persistent database connections for all services.
 * Configured via environment variables with sensible defaults for local development.
 */
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'findmy',
  user: process.env.POSTGRES_USER || 'findmy',
  password: process.env.POSTGRES_PASSWORD || 'findmy_secret',
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export default pool;
