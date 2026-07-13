import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate(): Promise<void> {
  console.log('Running migrations...');
  try {
    const schema = readFileSync(join(__dirname, 'init.sql'), 'utf-8');
    await db.query(schema);
    console.log('Migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

migrate();
