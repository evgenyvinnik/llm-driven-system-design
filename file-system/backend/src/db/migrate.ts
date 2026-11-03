/**
 * Applies init.sql. Every statement is idempotent, so this is safe to rerun.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config } from '../shared/config.js'
import { createPool } from '../shared/db.js'

const pool = createPool(config.databaseUrl)
try {
  await pool.query(readFileSync(fileURLToPath(new URL('./init.sql', import.meta.url)), 'utf8'))
  console.log('Migrations completed')
} catch (err) {
  console.error('Migration failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
