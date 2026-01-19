/**
 * Database seed script
 * Usage: npm run seed
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/models/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function seed(): Promise<void> {
  console.log('Seeding database...');

  try {
    // Read the seed.sql file
    const seedSqlPath = path.join(__dirname, '..', 'db-seed', 'seed.sql');
    const seedSql = fs.readFileSync(seedSqlPath, 'utf8');

    // Execute the SQL
    await db.query(seedSql);

    console.log('Database seeded successfully');

    // Show counts
    const urlCount = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM urls');
    const docCount = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM documents');
    const linkCount = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM links');
    const queryCount = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM query_logs');
    const suggestionCount = await db.query<{ count: string }>('SELECT COUNT(*) as count FROM search_suggestions');

    console.log('\nSeeded data:');
    console.log(`  URLs: ${urlCount.rows[0].count}`);
    console.log(`  Documents: ${docCount.rows[0].count}`);
    console.log(`  Links: ${linkCount.rows[0].count}`);
    console.log(`  Query logs: ${queryCount.rows[0].count}`);
    console.log(`  Search suggestions: ${suggestionCount.rows[0].count}`);
  } catch (error) {
    console.error('Seed failed:', error);
    throw error;
  } finally {
    await db.end();
  }
}

seed()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
