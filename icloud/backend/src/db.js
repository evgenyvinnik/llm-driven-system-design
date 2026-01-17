import pg from 'pg';
import Redis from 'ioredis';
import * as Minio from '@minio/minio-js';

const { Pool } = pg;

// PostgreSQL connection pool
export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'icloud_sync',
  user: process.env.POSTGRES_USER || 'icloud',
  password: process.env.POSTGRES_PASSWORD || 'icloud_secret',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Redis client
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
});

// MinIO client
export const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123',
});

// Test connections
export async function testConnections() {
  try {
    // Test PostgreSQL
    const pgResult = await pool.query('SELECT NOW()');
    console.log('PostgreSQL connected:', pgResult.rows[0].now);

    // Test Redis
    await redis.ping();
    console.log('Redis connected');

    // Test MinIO
    const buckets = await minioClient.listBuckets();
    console.log('MinIO connected, buckets:', buckets.map(b => b.name).join(', '));

    return true;
  } catch (error) {
    console.error('Connection test failed:', error);
    return false;
  }
}

// Graceful shutdown
export async function closeConnections() {
  await pool.end();
  await redis.quit();
  console.log('All connections closed');
}
