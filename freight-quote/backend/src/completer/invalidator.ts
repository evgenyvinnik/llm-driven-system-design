/**
 * Consumer of the pricing system's events (group `invalidator`).
 *
 * TariffPublished and FuelSurchargeChanged do three things:
 *  1. Raise the cache version floor (monotonic, idempotent; done first, so a
 *     retry after a failed transaction still invalidates).
 *  2. Record the event in our log and the version history (tariff_versions,
 *     fuel_surcharges), deduplicated by event_id. A duplicate stops here.
 *  3. If the event is newer than the current version, re-price open
 *     indicative quotes on the affected lanes and emit QuoteIssued
 *     (repriced). Firm quotes are commitments and are never re-priced.
 *
 * Events can arrive late or out of order (a replayed or retried publication).
 * Instead of relying on stream order, "current" only moves forward: an older
 * version is recorded in history but changes nothing.
 * @module completer/invalidator
 */
import type pg from 'pg'
import { config } from '../shared/config.js'
import { withTransaction } from '../shared/db.js'
import { appendEvents, recordExternalEvent } from '../shared/event-store.js'
import { quoteStream, type DomainEvent, type RawEnvelope } from '../shared/events.js'
import type { ComponentCache } from '../shared/component-cache.js'
import { MAX_CAPACITY_PREMIUM_PCT, type PriceComponent, type QuoteInputs } from '../shared/domain.js'

export type InvalidationResult = { outcome: 'duplicate' } | { outcome: 'stale'; current: string } | { outcome: 'applied'; repriced: number }

function toEnvelope(e: DomainEvent): RawEnvelope {
  const { storedVersion, ...rest } = e
  return { ...rest, version: storedVersion, payload: e.payload as Record<string, unknown> }
}

/** Re-prices one quote's component list; returns the new components, per-car delta and band shift. */
export function repriceComponents(components: PriceComponent[], change: { linehaulCents?: number; tariffVersion?: number; tariffId?: string; fuelCentsPerMile?: number; fuelDate?: string; laneMiles: number; asOf: string }) {
  let delta = 0
  let bandHighDelta = 0
  const next = components.map((c) => ({ ...c }))
  const linehaul = next.find((c) => c.component === 'linehaul')
  if (linehaul && change.linehaulCents !== undefined) {
    const before = linehaul.amountCentsPerCar
    linehaul.amountCentsPerCar = change.linehaulCents
    linehaul.basis = `tariff ${change.tariffId} v${change.tariffVersion}`
    linehaul.version = `tariff:v${change.tariffVersion}`
    linehaul.asOf = change.asOf
    linehaul.source = 'live'
    linehaul.ageSeconds = 0
    linehaul.latencyMs = null
    linehaul.detail = { ...linehaul.detail, tariffVersion: change.tariffVersion, repricedFrom: 'TariffPublished' }
    delta += change.linehaulCents - before
    const capacity = next.find((c) => c.component === 'capacity_premium')
    if (capacity) {
      const pct = typeof capacity.detail.premiumPct === 'number' ? capacity.detail.premiumPct : 0
      const capBefore = capacity.amountCentsPerCar
      capacity.amountCentsPerCar = Math.round((change.linehaulCents * pct) / 100)
      delta += capacity.amountCentsPerCar - capBefore
      if (capacity.source !== 'live') bandHighDelta += Math.round(((change.linehaulCents - before) * MAX_CAPACITY_PREMIUM_PCT) / 100)
    }
  }
  const fuel = next.find((c) => c.component === 'fuel_surcharge')
  if (fuel && change.fuelCentsPerMile !== undefined) {
    const before = fuel.amountCentsPerCar
    fuel.amountCentsPerCar = Math.round(change.laneMiles * change.fuelCentsPerMile)
    fuel.basis = `fuel surcharge, week of ${change.fuelDate}`
    fuel.version = `fsc:${change.fuelDate}`
    fuel.asOf = change.asOf
    fuel.source = 'live'
    fuel.staleness = null
    fuel.ageSeconds = 0
    fuel.latencyMs = null
    fuel.detail = { centsPerMile: change.fuelCentsPerMile, miles: change.laneMiles, repricedFrom: 'FuelSurchargeChanged' }
    delta += fuel.amountCentsPerCar - before
  }
  return { components: next, deltaPerCar: delta, bandHighDeltaPerCar: bandHighDelta }
}

async function repriceQuotes(
  client: pg.PoolClient,
  rows: Record<string, unknown>[],
  event: DomainEvent,
  reason: 'repriced_tariff' | 'repriced_fuel',
  changeFor: (row: Record<string, unknown>) => Parameters<typeof repriceComponents>[1],
): Promise<number> {
  let n = 0
  for (const q of rows) {
    const change = changeFor(q)
    const { components, deltaPerCar, bandHighDeltaPerCar } = repriceComponents(q.components as PriceComponent[], change)
    if (deltaPerCar === 0 && bandHighDeltaPerCar === 0 && reason === 'repriced_fuel' && (q.inputs as QuoteInputs).fuelSurchargeDate === change.fuelDate) continue
    const qty = q.quantity as number
    const inputs = { ...(q.inputs as QuoteInputs) }
    if (change.tariffVersion !== undefined) inputs.tariffVersion = change.tariffVersion
    if (change.fuelCentsPerMile !== undefined) {
      inputs.fuelCentsPerMile = change.fuelCentsPerMile
      inputs.fuelSurchargeDate = change.fuelDate ?? inputs.fuelSurchargeDate
    }
    const { rows: updated } = await client.query(
      `UPDATE quotes SET components = $2, inputs = $3, total_cents = total_cents + $4, band_low_cents = band_low_cents + $4,
         band_high_cents = band_high_cents + $4 + $5, revision = revision + 1, version = version + 1, updated_at = now()
       WHERE id = $1 AND kind = 'indicative' AND status = 'open' RETURNING *`,
      [q.id, JSON.stringify(components), JSON.stringify(inputs), deltaPerCar * qty, bandHighDeltaPerCar * qty],
    )
    const u = updated[0]
    if (!u) continue
    await appendEvents(
      client,
      [
        {
          type: 'QuoteIssued',
          streamId: quoteStream(q.id as string),
          correlationId: q.correlation_id as string,
          causationId: event.event_id,
          payload: {
            quote_id: q.id as string, customer_id: q.customer_id as string, kind: 'indicative', revision: u.revision as number, total_cents: Number(u.total_cents),
            currency: config.quote.currency, valid_until: new Date(u.valid_until).toISOString(),
            tariff_version: inputs.tariffVersion !== null ? `v${inputs.tariffVersion}` : null, surcharge_date: inputs.fuelSurchargeDate,
            reason, client_class: q.client_class as 'portal' | 'api' | 'api_requote', latency_ms: null,
            price_components: components.map((c) => ({
              component: c.component, dependency: c.dependency, source: c.source, version: c.version, as_of: c.asOf,
              age_seconds: c.ageSeconds, latency_ms: null, amount_cents_per_car: c.amountCentsPerCar,
            })),
          },
        },
      ],
      'invalidator',
    )
    n += 1
  }
  return n
}

export async function handleTariffPublished(event: DomainEvent<'TariffPublished'>, cache: ComponentCache): Promise<InvalidationResult> {
  const p = event.payload
  await cache.raiseTariffFloor(p.origin, p.destination, p.commodity, p.equipment, p.version)
  return withTransaction(async (client) => {
    if (!(await recordExternalEvent(client, toEnvelope(event)))) return { outcome: 'duplicate' }
    await client.query(
      `INSERT INTO tariff_versions (tariff_id, version, origin, destination, commodity, equipment, rate_per_car_cents, effective_at, event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [p.tariff_id, p.version, p.origin, p.destination, p.commodity, p.equipment, p.rate_per_car_cents, p.effective_at, event.event_id],
    )
    const moved = await client.query(
      `INSERT INTO tariff_current (tariff_id, version, rate_per_car_cents, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (tariff_id) DO UPDATE SET version = EXCLUDED.version, rate_per_car_cents = EXCLUDED.rate_per_car_cents, updated_at = now()
       WHERE tariff_current.version < EXCLUDED.version`,
      [p.tariff_id, p.version, p.rate_per_car_cents],
    )
    if (moved.rowCount === 0) {
      const { rows } = await client.query<{ version: number }>('SELECT version FROM tariff_current WHERE tariff_id = $1', [p.tariff_id])
      return { outcome: 'stale', current: `v${rows[0]?.version}` }
    }
    const { rows } = await client.query(
      `SELECT * FROM quotes WHERE status = 'open' AND kind = 'indicative' AND origin = $1 AND destination = $2 AND commodity = $3 AND equipment = $4
         AND inputs->>'pricingBasis' = 'tariff' AND COALESCE((inputs->>'tariffVersion')::int, 0) < $5
       ORDER BY created_at FOR UPDATE`,
      [p.origin, p.destination, p.commodity, p.equipment, p.version],
    )
    const repriced = await repriceQuotes(client, rows, event, 'repriced_tariff', (q) => ({
      linehaulCents: p.rate_per_car_cents,
      tariffVersion: p.version,
      tariffId: p.tariff_id,
      laneMiles: (q.inputs as QuoteInputs).laneMiles,
      asOf: p.effective_at,
    }))
    return { outcome: 'applied', repriced }
  })
}

export async function handleFuelSurchargeChanged(event: DomainEvent<'FuelSurchargeChanged'>, cache: ComponentCache): Promise<InvalidationResult> {
  const p = event.payload
  await cache.raiseFuelFloor(p.effective_date, p.published_at)
  return withTransaction(async (client) => {
    if (!(await recordExternalEvent(client, toEnvelope(event)))) return { outcome: 'duplicate' }
    const { rows: current } = await client.query<{ effective_date: string; published_at: Date }>(
      `SELECT to_char(effective_date, 'YYYY-MM-DD') AS effective_date, published_at FROM fuel_surcharges ORDER BY effective_date DESC, published_at DESC LIMIT 1`,
    )
    await client.query('INSERT INTO fuel_surcharges (event_id, effective_date, published_at, cents_per_mile) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
      event.event_id, p.effective_date, p.published_at, p.cents_per_mile,
    ])
    const cur = current[0]
    const newer = !cur || p.effective_date > cur.effective_date || (p.effective_date === cur.effective_date && new Date(p.published_at) > new Date(cur.published_at))
    if (!newer) return { outcome: 'stale', current: `${cur.effective_date} @ ${new Date(cur.published_at).toISOString()}` }
    const { rows } = await client.query(`SELECT * FROM quotes WHERE status = 'open' AND kind = 'indicative' ORDER BY created_at FOR UPDATE`)
    const repriced = await repriceQuotes(client, rows, event, 'repriced_fuel', (q) => ({
      fuelCentsPerMile: p.cents_per_mile,
      fuelDate: p.effective_date,
      laneMiles: (q.inputs as QuoteInputs).laneMiles,
      asOf: p.published_at,
    }))
    return { outcome: 'applied', repriced }
  })
}
