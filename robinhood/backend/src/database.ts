import { Pool } from 'pg';
import { config } from './config.js';

/**
 * PostgreSQL connection pool for the trading platform.
 * Manages database connections efficiently by reusing connections
 * across multiple queries, essential for high-throughput order processing.
 */
export const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.database,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

/**
 * Tests the database connection by executing a simple query.
 * Used during server startup to verify database availability
 * and for health check endpoints.
 * @returns Promise resolving to true if connection succeeds, false otherwise
 */
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}
