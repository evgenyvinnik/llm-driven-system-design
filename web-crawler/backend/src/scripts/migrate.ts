import { initDatabase, closeDatabase } from '../models/database.js';

async function migrate() {
  try {
    console.log('Running database migrations...');
    await initDatabase();
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

migrate();
