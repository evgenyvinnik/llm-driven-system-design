import pg from 'pg';

const { Pool } = pg;

let pool = null;

export async function initializeDb() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  // Test connection
  const client = await pool.connect();
  const result = await client.query('SELECT NOW()');
  console.log('Database connected:', result.rows[0].now);
  client.release();

  return pool;
}

export function getDb() {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool;
}

export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development' && duration > 100) {
    console.log('Slow query:', { text, duration, rows: result.rowCount });
  }
  return result;
}

export async function transaction(callback) {
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
