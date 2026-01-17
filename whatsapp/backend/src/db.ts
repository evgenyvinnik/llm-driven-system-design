import { Pool } from 'pg';
import { config } from './config.js';

/**
 * PostgreSQL connection pool.
 * Manages a pool of database connections for efficient query execution.
 * Used for persistent storage of users, conversations, messages, and message status.
 */
export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  user: config.postgres.user,
  password: config.postgres.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
  console.log('Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

/**
 * Tests the database connection by executing a simple query.
 * Used during health checks to verify database availability.
 * @returns Promise resolving to true if connection succeeds, false otherwise
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    return true;
  } catch (error) {
    console.error('Failed to connect to PostgreSQL:', error);
    return false;
  }
}
