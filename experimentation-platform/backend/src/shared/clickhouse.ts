/**
 * ClickHouse client. ClickHouse holds exposures, assignments and conversions;
 * every number on the results page is computed from them at read time.
 * @module shared/clickhouse
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { config } from './config.js'

const connection = {
  url: config.clickhouse.url,
  username: config.clickhouse.username,
  password: config.clickhouse.password,
}

export const clickhouse: ClickHouseClient = createClient({
  ...connection,
  database: config.clickhouse.database,
  request_timeout: 30_000,
  clickhouse_settings: { async_insert: 0 },
})

const schemaPath = fileURLToPath(new URL('../db/clickhouse-init.sql', import.meta.url))

/** Statements are idempotent (IF NOT EXISTS), so this is safe on every boot. */
export async function ensureClickHouseSchema(): Promise<void> {
  const statements = readFileSync(schemaPath, 'utf8')
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  // A client bound to a missing database fails every request, so create it through `default` first.
  const bootstrap = createClient({ ...connection, database: 'default' })
  try {
    await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${config.clickhouse.database}` })
  } finally {
    await bootstrap.close()
  }
  for (const query of statements) await clickhouse.command({ query })
}

/** Runs a parameterized SELECT and returns typed rows. */
export async function chQuery<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const result = await clickhouse.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: { output_format_json_quote_64bit_integers: 0, max_execution_time: 30 },
  })
  return result.json<T>()
}

/**
 * Inserts rows with an insert_deduplication_token: retrying the same insert
 * (same token) is a no-op, because the tables keep a non-replicated dedup window.
 */
export async function chInsert(table: string, values: object[], token: string): Promise<void> {
  if (values.length === 0) return
  await clickhouse.insert({
    table,
    values,
    format: 'JSONEachRow',
    clickhouse_settings: { insert_deduplication_token: token, insert_deduplicate: 1 },
  })
}
