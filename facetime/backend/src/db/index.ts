import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'facetime',
  password: process.env.DB_PASSWORD || 'facetime_dev_password',
  database: process.env.DB_NAME || 'facetime',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export async function query<T>(
  text: string,
  params?: (string | number | boolean | null | undefined)[]
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T>(
  text: string,
  params?: (string | number | boolean | null | undefined)[]
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.length > 0 ? result[0] : null;
}

export async function testConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    console.log('Database connection established');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}
