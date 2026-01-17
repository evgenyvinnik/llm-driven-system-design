/**
 * @fileoverview Database connection configuration for PostgreSQL and Redis.
 * PostgreSQL stores persistent data (users, posts, friendships, etc.).
 * Redis provides session caching, feed caching, and pub/sub for real-time updates.
 */

import { Pool } from 'pg';
import Redis from 'ioredis';

/**
 * PostgreSQL connection pool for efficient database query execution.
 * Uses pooling to reuse connections and handle concurrent requests.
 * Configuration is read from environment variables with local defaults.
 */
export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'newsfeed',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
});

/**
 * Redis client for caching and pub/sub messaging.
 * Used for session storage, feed caching, and real-time notifications.
 * Supports high-throughput operations with low latency.
 */
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

/**
 * Verifies connectivity to PostgreSQL and Redis before server startup.
 * Fails fast if databases are unreachable, preventing partial initialization.
 *
 * @returns Promise that resolves on successful connection to both databases
 * @throws Error if either database connection fails
 */
export async function testConnections(): Promise<void> {
  try {
    // Test PostgreSQL
    const pgClient = await pool.connect();
    console.log('PostgreSQL connected successfully');
    pgClient.release();

    // Test Redis
    await redis.ping();
    console.log('Redis connected successfully');
  } catch (error) {
    console.error('Database connection error:', error);
    throw error;
  }
}
