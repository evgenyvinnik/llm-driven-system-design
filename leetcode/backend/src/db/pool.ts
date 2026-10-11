import pg from 'pg';

const { Pool } = pg;

/** Connection settings shared by the pool and by dedicated clients (the judge worker's LISTEN connection). */
export const dbConfig: pg.ClientConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'leetcode',
  user: process.env.DB_USER || 'leetcode',
  password: process.env.DB_PASSWORD || 'leetcode_pass',
};

const pool = new Pool({
  ...dbConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/** PostgreSQL connection pool for the leetcode database with auto-reconnect. */
export default pool;
