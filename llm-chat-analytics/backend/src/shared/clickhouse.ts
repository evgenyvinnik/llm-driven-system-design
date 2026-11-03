/**
 * ClickHouse client and schema bootstrap. ClickHouse holds the raw events
 * (deduplicated by event_id) and the minute, hour and local-day rollups that
 * materialized views maintain on every insert.
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
  clickhouse_settings: {
    // Keep ingest synchronous: our own batches are the unit of dedup.
    async_insert: 0,
  },
})

const schemaPath = fileURLToPath(new URL('../../db/clickhouse-init.sql', import.meta.url))

/** Statements are idempotent (IF NOT EXISTS), so this is safe on every boot. */
export async function ensureClickHouseSchema(): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8')
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  // A native install may not have the database yet, and a client bound to a
  // missing database fails every request, so create it through `default` first.
  const bootstrap = createClient({ ...connection, database: 'default' })
  try {
    await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${config.clickhouse.database}` })
  } finally {
    await bootstrap.close()
  }
  for (const query of statements) {
    await clickhouse.command({ query })
  }
}

/** Runs a parameterized SELECT and returns typed rows. */
export async function chQuery<T>(
  query: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T[]> {
  const result = await clickhouse.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: {
      max_execution_time: Math.ceil(config.queryTimeoutMs / 1000),
      // UInt64 sums would otherwise arrive as strings.
      output_format_json_quote_64bit_integers: 0,
    },
  })
  return result.json<T>()
}
