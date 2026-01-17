import pg from 'pg';
import dotenv from 'dotenv';
import logger from '../shared/logger.js';
import { dbQueryDuration, dbPoolSize } from '../shared/metrics.js';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://reddit:reddit_password@localhost:5432/reddit',
  // Connection pool settings
  max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT, 10) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT, 10) || 2000,
});

// Log pool errors
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle database client');
});

// Track pool metrics
pool.on('connect', () => {
  dbPoolSize.set({ state: 'total' }, pool.totalCount);
  dbPoolSize.set({ state: 'idle' }, pool.idleCount);
  dbPoolSize.set({ state: 'waiting' }, pool.waitingCount);
});

pool.on('acquire', () => {
  dbPoolSize.set({ state: 'total' }, pool.totalCount);
  dbPoolSize.set({ state: 'idle' }, pool.idleCount);
  dbPoolSize.set({ state: 'waiting' }, pool.waitingCount);
});

pool.on('release', () => {
  dbPoolSize.set({ state: 'total' }, pool.totalCount);
  dbPoolSize.set({ state: 'idle' }, pool.idleCount);
  dbPoolSize.set({ state: 'waiting' }, pool.waitingCount);
});

/**
 * Execute a query with timing and logging.
 */
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;

    // Record query duration in metrics
    const operation = text.trim().split(/\s+/)[0].toUpperCase();
    dbQueryDuration.observe({ operation }, duration / 1000);

    // Log slow queries
    if (duration > 100) {
      logger.warn({
        duration,
        text: text.substring(0, 100),
        rows: res.rowCount,
      }, 'Slow query detected');
    } else if (process.env.NODE_ENV === 'development') {
      logger.debug({
        duration,
        text: text.substring(0, 100),
        rows: res.rowCount,
      }, 'Query executed');
    }

    return res;
  } catch (error) {
    const duration = Date.now() - start;
    logger.error({
      err: error,
      duration,
      text: text.substring(0, 200),
    }, 'Query failed');
    throw error;
  }
};

/**
 * Get a client from the pool for transactions.
 */
export const getClient = async () => {
  const client = await pool.connect();
  return client;
};

export default pool;
