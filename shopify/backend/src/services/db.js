import pg from 'pg';
import config from '../config/index.js';

const { Pool } = pg;

// Main pool for general queries
const pool = new Pool(config.database);

// Test connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Execute a query with tenant context set
export async function queryWithTenant(storeId, query, params = []) {
  const client = await pool.connect();
  try {
    // Set the tenant context for Row-Level Security
    await client.query(`SET app.current_store_id = '${storeId}'`);
    const result = await client.query(query, params);
    return result;
  } finally {
    client.release();
  }
}

// Execute a query without tenant context (for platform operations)
export async function query(query, params = []) {
  return pool.query(query, params);
}

// Get a client with tenant context set (for transactions)
export async function getClientWithTenant(storeId) {
  const client = await pool.connect();
  await client.query(`SET app.current_store_id = '${storeId}'`);
  return client;
}

export default pool;
