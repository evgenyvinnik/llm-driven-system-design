/**
 * Replaces everything in the development database with the demo data.
 */
import { config } from '../shared/config.js'
import { createPool } from '../shared/db.js'
import { PgBackend } from '../store/pg-backend.js'
import { seedDemo } from './seed-data.js'

const backend = new PgBackend(createPool(config.databaseUrl))
try {
  await seedDemo(backend)
  console.log('Seeded the demo users and files')
} catch (err) {
  console.error('Seeding failed:', err)
  process.exitCode = 1
} finally {
  await backend.close()
}
