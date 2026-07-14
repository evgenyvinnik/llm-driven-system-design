import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgresql://fb_search:fb_search_password@localhost:5432/fb_post_search',
});

async function migrate(): Promise<void> {
  console.log('Running migrations...');
  try {
    const schema = readFileSync(join(__dirname, 'init.sql'), 'utf-8');
    await pool.query(schema);
    console.log('Migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
