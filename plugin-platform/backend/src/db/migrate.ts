import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../shared/db.js';
import { logger } from '../shared/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const client = await pool.connect();

  try {
    // Create migrations table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Get list of applied migrations
    const { rows: applied } = await client.query('SELECT name FROM migrations');
    const appliedSet = new Set(applied.map((r) => r.name));

    // Get migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        logger.info(`Skipping already applied migration: ${file}`);
        continue;
      }

      logger.info(`Applying migration: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`Applied migration: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    logger.info('All migrations applied successfully');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  logger.error(err, 'Migration failed');
  process.exit(1);
});
