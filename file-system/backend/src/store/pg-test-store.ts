/**
 * Fresh PgSpecStore for each conformance test. Uses its own database
 * (TEST_DATABASE_URL, default file_system_test), created on first use, so the
 * tests never wipe the seeded development data.
 * @module store/pg-test-store
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { config } from '../shared/config.js'
import { createPool } from '../shared/db.js'
import { PgBackend } from './pg-backend.js'
import { PgSpecStore } from './pg-spec-store.js'

let backend: Promise<PgBackend> | undefined

async function prepare(): Promise<PgBackend> {
  const url = new URL(config.testDatabaseUrl)
  const database = url.pathname.slice(1)
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() })
  await admin.connect()
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${database.replace(/"/g, '')}"`)
  } finally {
    await admin.end()
  }
  const pool = createPool(config.testDatabaseUrl)
  await pool.query(readFileSync(fileURLToPath(new URL('../db/init.sql', import.meta.url)), 'utf8'))
  return new PgBackend(pool)
}

export async function createTestPgStore(): Promise<PgSpecStore> {
  backend ??= prepare()
  const ready = await backend
  await ready.clear()
  return new PgSpecStore(ready)
}

/** The raw backend, emptied, for tests that need the throwing API (concurrency tests). */
export async function createTestPgBackend(): Promise<PgBackend> {
  backend ??= prepare()
  const ready = await backend
  await ready.clear()
  return ready
}
