/**
 * Database migration runner
 * @module db/migrate
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pool, query } from '../shared/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function migrate(): Promise<void> {
  console.log('Running database migrations...')

  // Create migrations tracking table
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Get applied migrations
  const result = await query<{ filename: string }>('SELECT filename FROM schema_migrations')
  const appliedMigrations = new Set(result.rows.map((r) => r.filename))

  // Get migration files
  const migrationsDir = path.join(__dirname, 'migrations')
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

  for (const file of files) {
    if (appliedMigrations.has(file)) {
      console.log(`Skipping ${file} (already applied)`)
      continue
    }

    console.log(`Applying ${file}...`)
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')

    try {
      await query(sql)
      await query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
      console.log(`Applied ${file}`)
    } catch (error) {
      console.error(`Failed to apply ${file}:`, error)
      throw error
    }
  }

  console.log('Migrations complete')
  await pool.end()
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
