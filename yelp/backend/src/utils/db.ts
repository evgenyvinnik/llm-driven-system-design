import pg, { Pool, PoolClient } from 'pg';

const { Pool: PgPool } = pg;

export const pool: Pool = new PgPool({
  connectionString: process.env.DATABASE_URL,
});

// Helper function for transactions
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
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
export function buildQuery(
  template: string,
  params: Record<string, unknown>
): { text: string; values: unknown[] } {
  let query = template;
  const values: unknown[] = [];
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

export default pool;
