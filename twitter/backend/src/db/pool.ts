import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

/** PostgreSQL connection pool for the Twitter database. */
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgresql://twitter:twitter_secret@localhost:5432/twitter_db',
});

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export default pool;
