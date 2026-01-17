import { Pool } from 'pg';

/**
 * PostgreSQL connection pool for the Figma clone application.
 * Manages connections to the database for file metadata, versions, and operations storage.
 * Uses environment variables for configuration with sensible defaults for local development.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'figma',
  password: process.env.DB_PASSWORD || 'figma_password',
  database: process.env.DB_NAME || 'figma_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Executes a SQL query and returns all matching rows.
 * Used for fetching multiple records like file lists or version history.
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Optional array of values to substitute into the query placeholders
 * @returns Promise resolving to an array of typed rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Executes a SQL query and returns the first row or null.
 * Used for fetching single records like a specific file or version.
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Optional array of values to substitute into the query placeholders
 * @returns Promise resolving to a single typed row or null if not found
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) || null;
}

/**
 * Executes a SQL command that modifies data (INSERT, UPDATE, DELETE).
 * Used for creating, updating, or deleting files, versions, and operations.
 * @param text - The SQL command string with optional $1, $2, etc. placeholders
 * @param params - Optional array of values to substitute into the command placeholders
 * @returns Promise resolving to the number of affected rows
 */
export async function execute(text: string, params?: unknown[]): Promise<number> {
  const result = await pool.query(text, params);
  return result.rowCount || 0;
}

/**
 * Tests the database connection by executing a simple query.
 * Called during server startup to verify PostgreSQL is accessible.
 * @returns Promise resolving to true if connection is successful, false otherwise
 */
export async function testConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT NOW()');
    console.log('PostgreSQL connected successfully');
    return true;
  } catch (error) {
    console.error('PostgreSQL connection failed:', error);
    return false;
  }
}

export default pool;
