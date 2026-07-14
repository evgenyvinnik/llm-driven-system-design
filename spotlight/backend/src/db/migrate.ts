/**
 * Database migration runner
 * @module db/migrate
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgresql://spotlight:spotlight_password@localhost:5432/spotlight',
})

async function migrate(): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf-8')

  try {
    await pool.query(sql)
    console.log('Database migration completed successfully')
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

migrate()
