import pg from 'pg';
import dotenv from 'dotenv';

const { Pool } = pg;

dotenv.config();

/** PostgreSQL connection pool for the Splitwise expense-tracking system. */
export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'splitwise',
  password: process.env.POSTGRES_PASSWORD || 'splitwise_password',
  database: process.env.POSTGRES_DB || 'splitwise',
});

/**
 * Executes a callback within a PostgreSQL transaction with automatic
 * BEGIN/COMMIT/ROLLBACK. Used for expense creation, which writes an expense
 * row plus N split rows atomically — a partial write would corrupt balances.
 */
export const transaction = async <T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
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
};
