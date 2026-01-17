import pg from 'pg';
import IORedis from 'ioredis';

const { Pool } = pg;
const Redis = IORedis.default || IORedis;

/**
 * PostgreSQL connection pool for database operations.
 * Provides a managed pool of database connections for efficient query execution.
 * Configured with sensible defaults for connection limits and timeouts.
 */
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'calendly',
  user: process.env.DB_USER || 'calendly',
  password: process.env.DB_PASSWORD || 'calendly_password',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Redis client for caching and session management.
 * Used throughout the application for caching user data, meeting types,
 * availability slots, and storing session data for authenticated users.
 */
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
});

/**
 * Tests the PostgreSQL database connection.
 * Used during application startup to verify database connectivity
 * and for health check endpoints.
 * @returns Promise resolving to true if connection succeeds, false otherwise
 */
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('PostgreSQL connected successfully');
    return true;
  } catch (error) {
    console.error('PostgreSQL connection error:', error);
    return false;
  }
}

/**
 * Tests the Redis connection.
 * Used during application startup to verify Redis connectivity
 * and for health check endpoints. Sessions and caching require Redis.
 * @returns Promise resolving to true if connection succeeds, false otherwise
 */
export async function testRedisConnection(): Promise<boolean> {
  try {
    await redis.ping();
    console.log('Redis connected successfully');
    return true;
  } catch (error) {
    console.error('Redis connection error:', error);
    return false;
  }
}

/**
 * Gracefully closes all database and cache connections.
 * Should be called during application shutdown to ensure clean resource cleanup.
 * @returns Promise that resolves when all connections are closed
 */
export async function closeConnections(): Promise<void> {
  await pool.end();
  await redis.quit();
}
