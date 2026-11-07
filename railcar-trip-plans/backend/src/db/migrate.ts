/**
 * Applies init.sql. Every statement is idempotent, so this is safe to rerun.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pool } from '../shared/db.js'

const here = dirname(fileURLToPath(import.meta.url))

try {
  await pool.query(readFileSync(join(here, 'init.sql'), 'utf8'))
  console.log('Migrations completed')
} catch (err) {
  console.error('Migration failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
