import pg from 'pg';
import Redis from 'ioredis';

const { Pool } = pg;

// PostgreSQL connection pool
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

// Redis client for caching and sessions
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
});

// Test database connection
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

// Test Redis connection
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

// Graceful shutdown
export async function closeConnections(): Promise<void> {
  await pool.end();
  await redis.quit();
}
