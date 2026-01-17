import { Pool } from 'pg';
import Redis from 'ioredis';

// PostgreSQL connection
export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'newsfeed',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
});

// Redis connection
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

// Test connections
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
