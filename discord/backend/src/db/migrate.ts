// Database migration script
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrate() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://discord:discord@localhost:5432/babydiscord',
  });

  try {
    console.log('Running database migrations...');

    const initSql = readFileSync(join(__dirname, 'init.sql'), 'utf-8');
    await pool.query(initSql);

    console.log('Database migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
