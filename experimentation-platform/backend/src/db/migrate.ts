/**
 * Applies the PostgreSQL schema (init.sql) and the ClickHouse schema
 * (clickhouse-init.sql). Every statement in both is idempotent.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { clickhouse, ensureClickHouseSchema } from '../shared/clickhouse.js'
import { pool } from '../shared/db.js'

async function waitFor(name: string, probe: () => Promise<unknown>, attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await probe()
      return
    } catch (err) {
      if (i === attempts) throw err
      console.log(`Waiting for ${name}... (${(err as Error).message})`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

async function migrate(): Promise<void> {
  try {
    await waitFor('PostgreSQL', () => pool.query('SELECT 1'))
    await pool.query(readFileSync(fileURLToPath(new URL('./init.sql', import.meta.url)), 'utf8'))
    console.log('PostgreSQL schema applied')
    await waitFor('ClickHouse', async () => {
      const ping = await clickhouse.ping()
      if (!ping.success) throw new Error('ping failed')
    })
    await ensureClickHouseSchema()
    console.log('ClickHouse schema applied')
  } catch (err) {
    console.error('Migration failed:', err)
    process.exitCode = 1
  } finally {
    await pool.end()
    await clickhouse.close()
  }
}

await migrate()
