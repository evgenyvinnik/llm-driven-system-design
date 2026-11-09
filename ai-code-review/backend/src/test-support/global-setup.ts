/**
 * Creates and migrates a dedicated test database when a PostgreSQL server is
 * reachable. Tests that need it read `dbReady` and skip themselves otherwise,
 * so `npm test` still means something on a machine without Docker running.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { GlobalSetupContext } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    dbReady: boolean
  }
}

const here = dirname(fileURLToPath(import.meta.url))

export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const base = process.env.DATABASE_URL || 'postgresql://review:review_password@localhost:5432/ai_code_review'
  const testUrl = process.env.TEST_DATABASE_URL || base.replace(/\/[^/?]+(\?.*)?$/, '/ai_code_review_test$1')
  const dbName = new URL(testUrl).pathname.slice(1)
  const admin = new pg.Client({ connectionString: base, connectionTimeoutMillis: 2000 })
  try {
    await admin.connect()
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName])
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`)
    await admin.end()
    const client = new pg.Client({ connectionString: testUrl, connectionTimeoutMillis: 2000 })
    await client.connect()
    await client.query(readFileSync(join(here, '../db/init.sql'), 'utf8'))
    await client.end()
    provide('dbReady', true)
  } catch {
    await admin.end().catch(() => undefined)
    provide('dbReady', false)
  }
}
