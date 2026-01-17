import { Pool } from 'pg';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// PostgreSQL connection pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Redis client
export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// System account IDs
export const SYSTEM_ACCOUNTS = {
  ACCOUNTS_RECEIVABLE: '00000000-0000-0000-0000-000000000001',
  PLATFORM_REVENUE: '00000000-0000-0000-0000-000000000002',
  PENDING_SETTLEMENTS: '00000000-0000-0000-0000-000000000003',
} as const;

// Helper for running queries
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

// Helper for running a single query
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) || null;
}

// Transaction helper for atomic operations
export async function withTransaction<T>(
  callback: (client: import('pg').PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Cleanup on shutdown
export async function closeConnections(): Promise<void> {
  await pool.end();
  await redis.quit();
}
