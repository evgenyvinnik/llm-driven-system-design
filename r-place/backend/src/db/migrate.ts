/**
 * Database migration runner
 * @module db/migrate
 */
import fs from 'fs'
import path from 'path'
import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://rplace:rplace_dev@localhost:5432/rplace',
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
