import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Helper function for transactions
export async function withTransaction(callback) {
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

// Helper for parameterized queries with named parameters
export function buildQuery(template, params) {
  let query = template;
  let values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query = query.replace(new RegExp(`:${key}`, 'g'), `$${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  return { text: query, values };
}
