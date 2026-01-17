import { Pool } from 'pg';

/**
 * PostgreSQL connection pool for the Google Docs clone.
 * Manages database connections with automatic pooling and reconnection.
 * Used by all backend services to interact with the relational database
 * storing users, documents, permissions, versions, comments, and suggestions.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'googledocs',
  password: process.env.DB_PASSWORD || 'googledocs_secret',
  database: process.env.DB_NAME || 'googledocs',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Handles unexpected errors on idle database clients.
 * Logs errors but keeps the pool operational for other connections.
 */
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

/** Default PostgreSQL connection pool instance */
export default pool;
