import pg from 'pg';
import { createClient } from 'redis';

const { Pool } = pg;

// PostgreSQL connection pool
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'spotify',
  user: process.env.DB_USER || 'spotify',
  password: process.env.DB_PASSWORD || 'spotify_secret',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Redis client
export const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

export async function initializeDatabase() {
  await redisClient.connect();
  console.log('Connected to Redis');

  const client = await pool.connect();
  console.log('Connected to PostgreSQL');
  client.release();
}
