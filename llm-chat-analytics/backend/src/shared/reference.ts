/**
 * Reference data from PostgreSQL that ingest and the API read constantly: org
 * time zones and model prices. Cached in memory and refreshed every minute, so
 * a time-zone change applies to new events within a minute (old local-day
 * rollups need `rollups:rebuild`).
 * @module shared/reference
 */
import { pool } from './db.js'
import type { OrgInfo, Price } from '../ingest/pipeline.js'

export interface OrgRecord extends OrgInfo {
  id: string
  name: string
}

let orgs = new Map<string, OrgRecord>()
let prices: Price[] = []
let loadedAt = 0

export async function refreshReference(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < 60_000) return
  const [orgRows, priceRows] = await Promise.all([
    pool.query<{ id: string; name: string; time_zone: string }>('SELECT id, name, time_zone FROM orgs'),
    pool.query<{ model: string; effective_from: Date; input_micros_per_mtok: string; output_micros_per_mtok: string }>(
      'SELECT model, effective_from, input_micros_per_mtok, output_micros_per_mtok FROM model_prices ORDER BY model, effective_from DESC',
    ),
  ])
  orgs = new Map(orgRows.rows.map((r) => [r.id, { id: r.id, name: r.name, timeZone: r.time_zone }]))
  prices = priceRows.rows.map((r) => ({
    model: r.model,
    effectiveFrom: r.effective_from.getTime(),
    inputMicrosPerMTok: Number(r.input_micros_per_mtok),
    outputMicrosPerMTok: Number(r.output_micros_per_mtok),
  }))
  loadedAt = Date.now()
}

export function getOrgs(): Map<string, OrgRecord> {
  return orgs
}

export function getPrices(): Price[] {
  return prices
}
