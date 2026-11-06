/**
 * Seeds reference data, users and about three days of quote history. Rerunnable:
 * it wipes the database tables and every fq:* key in Valkey, then reseeds.
 *
 * History is written as quotes rows plus their events, unpublished, so the
 * running relay publishes them and the projector builds analytics from them
 * like any other events. Quotes older than 30 hours carry QuoteIssued v1
 * (before the price-provenance migration), so replay exercises the upcaster.
 * All volumes, prices and latencies are illustrative.
 */
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type pg from 'pg'
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { hashApiKey } from '../shared/auth.js'
import { appendEvents } from '../shared/event-store.js'
import { quoteStream, type NewEvent } from '../shared/events.js'
import { webhookSecretFor } from '../shared/webhook-secrets.js'
import {
  COMMODITIES,
  CONTRACTS,
  CUSTOMERS,
  INITIAL_FUEL_CENTS_PER_MILE,
  INITIAL_TARIFF_VERSION,
  LANES,
  tariffIdOf,
  tariffRateCents,
  weekStart,
  type ClientClass,
} from '../shared/reference.js'
import type { PriceComponent, QuoteInputs } from '../shared/domain.js'

const USERS = [
  { username: 'pat', name: 'Pat Delgado', role: 'customer', customer: 'CUST-PGC' },
  { username: 'nina', name: 'Nina Haugen', role: 'customer', customer: 'CUST-NLL' },
  { username: 'omar', name: 'Omar Reyes', role: 'ops', customer: null },
  { username: 'ada', name: 'Ada Kowalski', role: 'admin', customer: null },
] as const

let seed = 2026
function rand(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]

async function wipeRedis(): Promise<void> {
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'fq:*', 'COUNT', 500)
    cursor = next
    if (keys.length) await redis.del(...keys)
  } while (cursor !== '0')
}

async function seedReference(client: pg.PoolClient): Promise<void> {
  for (const c of CUSTOMERS) {
    await client.query('INSERT INTO customers (id, name, api_key_hash, webhook_url, webhook_secret, rate_limit_per_min) VALUES ($1, $2, $3, $4, $5, $6)', [
      c.id,
      c.name,
      c.apiKey ? hashApiKey(c.apiKey) : null,
      c.webhook ? `${config.receiverUrl}/hooks/${c.id}` : null,
      webhookSecretFor(c.id),
      c.ratePerMinute,
    ])
  }
  const hash = await bcrypt.hash('password123', 10)
  for (const u of USERS) {
    await client.query('INSERT INTO users (username, display_name, password_hash, role, customer_id) VALUES ($1, $2, $3, $4, $5)', [u.username, u.name, hash, u.role, u.customer])
  }
  for (const c of CONTRACTS) {
    await client.query('INSERT INTO contracts (id, customer_id, version, origin, destination, commodity, equipment) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      c.id, c.customerId, c.version, c.origin, c.destination, c.commodity, c.equipment,
    ])
  }
  const publishedAt = new Date(Date.now() - 14 * 86_400_000)
  for (const lane of LANES) {
    for (const commodity of COMMODITIES) {
      for (const equipment of commodity.equipment) {
        const id = tariffIdOf(lane.origin, lane.destination, commodity.code, equipment)
        const rate = tariffRateCents(lane.origin, lane.destination, commodity.code, equipment, INITIAL_TARIFF_VERSION) as number
        await client.query(
          `INSERT INTO tariff_versions (tariff_id, version, origin, destination, commodity, equipment, rate_per_car_cents, effective_at, event_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, INITIAL_TARIFF_VERSION, lane.origin, lane.destination, commodity.code, equipment, rate, publishedAt, randomUUID()],
        )
        await client.query('INSERT INTO tariff_current (tariff_id, version, rate_per_car_cents) VALUES ($1, $2, $3)', [id, INITIAL_TARIFF_VERSION, rate])
      }
    }
  }
  await client.query('INSERT INTO fuel_surcharges (event_id, effective_date, published_at, cents_per_mile) VALUES ($1, $2, $3, $4)', [
    randomUUID(), weekStart(new Date()), new Date(Date.now() - 3 * 86_400_000), INITIAL_FUEL_CENTS_PER_MILE,
  ])
}

interface HistoricQuote {
  id: string
  at: Date
  customerId: string
  cls: ClientClass
  lane: (typeof LANES)[number]
  commodity: string
  equipment: string
  quantity: number
  indicative: boolean
  booked: boolean
}

function componentsFor(q: HistoricQuote, latency: Record<string, number>, indicative: boolean): { components: PriceComponent[]; inputs: QuoteInputs; perCar: number } {
  const contract = CONTRACTS.find((c) => c.customerId === q.customerId && c.origin === q.lane.origin && c.destination === q.lane.destination && c.commodity === q.commodity && c.equipment === q.equipment)
  const tariffId = tariffIdOf(q.lane.origin, q.lane.destination, q.commodity, q.equipment)
  const linehaul = contract ? contract.ratePerCarCents : (tariffRateCents(q.lane.origin, q.lane.destination, q.commodity, q.equipment, INITIAL_TARIFF_VERSION) as number)
  const fuel = Math.round(q.lane.miles * INITIAL_FUEL_CENTS_PER_MILE)
  const premiumPct = rand() < 0.3 ? Math.round(rand() * 120) / 10 : 0
  const capacity = Math.round((linehaul * premiumPct) / 100)
  const asOf = q.at.toISOString()
  const base = { ageSeconds: 0, staleness: null, asOf }
  const components: PriceComponent[] = [
    { ...base, component: 'linehaul', dependency: 'pricing', source: rand() < 0.7 ? 'cache' : 'live', amountCentsPerCar: linehaul, basis: contract ? `contract ${contract.id} v${contract.version}` : `tariff ${tariffId} v${INITIAL_TARIFF_VERSION}`, version: contract ? `contract:${contract.id}:v${contract.version}` : `tariff:v${INITIAL_TARIFF_VERSION}`, latencyMs: latency.pricing, detail: {} },
    { ...base, component: 'fuel_surcharge', dependency: 'fuel', source: rand() < 0.8 ? 'cache' : 'live', amountCentsPerCar: fuel, basis: `fuel surcharge, week of ${weekStart(q.at)}`, version: `fsc:${weekStart(q.at)}`, latencyMs: latency.fuel, detail: { centsPerMile: INITIAL_FUEL_CENTS_PER_MILE, miles: q.lane.miles } },
    { ...base, component: 'capacity_premium', dependency: 'capacity', source: indicative ? 'fallback' : 'live', amountCentsPerCar: indicative ? 0 : capacity, basis: indicative ? 'capacity not confirmed' : 'capacity snapshot', version: null, latencyMs: indicative ? null : latency.capacity, detail: { premiumPct } },
    { ...base, component: 'equipment', dependency: 'availability', source: 'live', amountCentsPerCar: 0, basis: 'car supply snapshot', version: null, latencyMs: latency.availability, detail: {} },
  ]
  for (const c of components) if (c.source === 'cache') c.latencyMs = null
  const perCar = components.reduce((s, c) => s + c.amountCentsPerCar, 0)
  const inputs: QuoteInputs = {
    pricingBasis: contract ? 'contract' : 'tariff',
    tariffId,
    tariffVersion: contract ? null : INITIAL_TARIFF_VERSION,
    contractId: contract?.id ?? null,
    contractVersion: contract?.version ?? null,
    fuelSurchargeDate: weekStart(q.at),
    fuelCentsPerMile: INITIAL_FUEL_CENTS_PER_MILE,
    capacitySnapshotId: indicative ? null : `cap-hist-${q.id.slice(0, 8)}`,
    availabilitySnapshotId: `avl-hist-${q.id.slice(0, 8)}`,
    laneMiles: q.lane.miles,
    rulesVersion: config.quote.rulesVersion,
  }
  return { components, inputs, perCar }
}

const lognormal = (median: number, sigma: number) => Math.round(median * Math.exp(sigma * Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand())))

async function seedHistory(client: pg.PoolClient): Promise<number> {
  const now = Date.now()
  const quotes: HistoricQuote[] = []
  // About 70 hours of history, busier in US Central business hours (illustrative volumes).
  const slots: number[] = []
  for (let h = 70; h >= 1; h -= 1) {
    const hourStart = now - h * 3_600_000
    const localHour = (new Date(hourStart).getUTCHours() + 18) % 24
    const busy = localHour >= 7 && localHour <= 18
    const n = busy ? 4 + Math.floor(rand() * 7) : Math.floor(rand() * 3)
    for (let j = 0; j < n; j += 1) slots.push(hourStart + Math.floor(rand() * 3_500_000))
  }
  for (const at of slots) {
    const customer = pick(CUSTOMERS)
    const cls: ClientClass = customer.apiKey ? (rand() < 0.35 ? 'api_requote' : 'api') : 'portal'
    const contract = rand() < 0.45 ? CONTRACTS.find((c) => c.customerId === customer.id) : undefined
    const lane = contract ? LANES.find((l) => l.origin === contract.origin && l.destination === contract.destination)! : pick(LANES)
    const commodity = contract ? COMMODITIES.find((c) => c.code === contract.commodity)! : pick(COMMODITIES)
    quotes.push({
      id: randomUUID(),
      at: new Date(at),
      customerId: customer.id,
      cls,
      lane,
      commodity: commodity.code,
      equipment: contract ? contract.equipment : pick(commodity.equipment),
      quantity: 1 + Math.floor(rand() * 25),
      indicative: rand() < 0.3,
      booked: rand() < 0.28,
    })
  }

  const migration = now - 30 * 3_600_000
  for (const q of quotes) {
    const latency = { pricing: lognormal(60, 0.3), fuel: lognormal(25, 0.3), capacity: lognormal(130, 0.6), availability: lognormal(95, 0.4) }
    const firm = componentsFor(q, latency, false)
    const first = q.indicative ? componentsFor(q, latency, true) : firm
    const corr = `corr-seed-${q.id.slice(0, 8)}`
    const shipWeek = weekStart(new Date(q.at.getTime() + 14 * 86_400_000))
    const firmAt = new Date(q.at.getTime() + (q.indicative ? 1_500 + Math.floor(rand() * 6_000) : 0))
    const validUntil = new Date(firmAt.getTime() + 24 * 3_600_000)
    const expired = validUntil.getTime() < now && !q.booked
    const status = q.booked ? 'booked' : expired ? 'expired' : 'open'
    const total = firm.perCar * q.quantity
    const quoteLatency = q.indicative ? 900 : Math.max(latency.pricing, latency.fuel, latency.capacity, latency.availability) + 12

    await client.query(
      `INSERT INTO quotes (id, customer_id, idempotency_key, request_hash, client_class, origin, destination, commodity, equipment, quantity, ship_week, kind, firm_status,
         status, revision, total_cents, band_low_cents, band_high_cents, inputs, components, valid_until, callback, deadline_ms, latency_ms, correlation_id, created_at, firm_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'firm',$12,$13,$14,$15,$15,$15,$16,$17,$18,false,900,$19,$20,$21,$22,$22)`,
      [
        q.id, q.customerId, `seed-${q.id}`, 'seed', q.cls, q.lane.origin, q.lane.destination, q.commodity, q.equipment, q.quantity, shipWeek,
        q.indicative ? 'completed' : 'not_needed', status, q.indicative ? 2 : 1, total, JSON.stringify(firm.inputs), JSON.stringify(firm.components), validUntil,
        quoteLatency, corr, q.at, firmAt,
      ],
    )

    const v1 = q.at.getTime() < migration
    const stream = quoteStream(q.id)
    const events: NewEvent[] = [
      {
        type: 'QuoteRequested', streamId: stream, correlationId: corr, occurredAt: q.at,
        payload: { quote_id: q.id, customer_id: q.customerId, client_class: q.cls, origin: q.lane.origin, destination: q.lane.destination, commodity: q.commodity, equipment: q.equipment, quantity: q.quantity, ship_week: shipWeek, idempotency_key: `seed-${q.id}`, deadline_ms: 900, needs_firm: q.indicative },
      },
    ]
    const issued = (kind: 'firm' | 'indicative', c: typeof firm, reason: 'initial' | 'firm_completed', at: Date, revision: number): NewEvent => {
      const flat = { quote_id: q.id, customer_id: q.customerId, kind, revision, total_cents: c.perCar * q.quantity, currency: 'USD', valid_until: (kind === 'firm' ? validUntil : new Date(at.getTime() + 15 * 60_000)).toISOString(), tariff_version: c.inputs.tariffVersion ? `v${c.inputs.tariffVersion}` : null, surcharge_date: c.inputs.fuelSurchargeDate }
      if (v1) return { type: 'QuoteIssued', version: 1, streamId: stream, correlationId: corr, occurredAt: at, payload: flat as never }
      return {
        type: 'QuoteIssued', streamId: stream, correlationId: corr, occurredAt: at,
        payload: { ...flat, reason, client_class: q.cls, latency_ms: reason === 'initial' ? quoteLatency : null, price_components: c.components.map((x) => ({ component: x.component, dependency: x.dependency, source: x.source, version: x.version, as_of: x.asOf, age_seconds: x.ageSeconds, latency_ms: x.latencyMs, amount_cents_per_car: x.amountCentsPerCar })) },
      }
    }
    events.push(issued(q.indicative ? 'indicative' : 'firm', first, 'initial', new Date(q.at.getTime() + quoteLatency), 1))
    if (q.indicative) {
      events.push({
        type: 'FirmQuoteCompleted', streamId: stream, correlationId: corr, occurredAt: firmAt,
        payload: { quote_id: q.id, customer_id: q.customerId, total_cents: total, indicative_total_cents: first.perCar * q.quantity, valid_until: validUntil.toISOString(), tariff_version: firm.inputs.tariffVersion ? `v${firm.inputs.tariffVersion}` : null, surcharge_date: firm.inputs.fuelSurchargeDate, attempts: 1, completion_ms: firmAt.getTime() - q.at.getTime() },
      })
      events.push(issued('firm', firm, 'firm_completed', firmAt, 2))
    }
    if (q.booked) {
      events.push({
        type: 'QuoteBooked', streamId: stream, correlationId: corr, occurredAt: new Date(firmAt.getTime() + 3_600_000 * (1 + rand() * 10)),
        payload: { quote_id: q.id, booking_id: randomUUID(), customer_id: q.customerId, kind: 'firm', honored_total_cents: total, honored_tariff_version: firm.inputs.tariffVersion ? `v${firm.inputs.tariffVersion}` : null, current_tariff_version: firm.inputs.tariffVersion ? `v${firm.inputs.tariffVersion}` : null },
      })
    } else if (expired) {
      events.push({ type: 'QuoteExpired', streamId: stream, correlationId: corr, occurredAt: validUntil, payload: { quote_id: q.id, customer_id: q.customerId, kind: 'firm', valid_until: validUntil.toISOString() } })
    }
    const written = await appendEvents(client, events, v1 ? 'quote-api@2026.2' : 'quote-api')
    // History was recorded when it happened, not now.
    await client.query(`UPDATE events SET recorded_at = occurred_at + interval '40 milliseconds' WHERE event_id = ANY($1::uuid[])`, [written.map((e) => e.event_id)])
    if (q.booked) {
      const booked = written.find((e) => e.type === 'QuoteBooked')!
      await client.query('INSERT INTO bookings (id, quote_id, customer_id, idempotency_key, honored_total_cents, honored_inputs, current_tariff_version, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        (booked.payload as { booking_id: string }).booking_id, q.id, q.customerId, `seed-book-${q.id}`, total, JSON.stringify(firm.inputs), firm.inputs.tariffVersion, booked.occurred_at,
      ])
    }
  }
  return quotes.length
}

async function main(): Promise<void> {
  await wipeRedis()
  const n = await withTransaction(async (client) => {
    await client.query(`TRUNCATE webhook_deliveries, bookings, quotes, processed_events, analytics_counters, analytics_latency, analytics_sources,
      projection_checkpoints, tariff_versions, tariff_current, fuel_surcharges, contracts, users, customers RESTART IDENTITY CASCADE`)
    // The log is append-only by trigger; a reseed is the one place allowed to clear it.
    await client.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
    await client.query('TRUNCATE events RESTART IDENTITY')
    await seedReference(client)
    const count = await seedHistory(client)
    await client.query('ALTER TABLE events ENABLE TRIGGER events_append_only')
    return count
  })
  const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM events')
  console.log(`Seeded ${CUSTOMERS.length} customers, ${USERS.length} users (password123), ${CONTRACTS.length} contract lanes, ${n} historic quotes, ${rows[0].n} events (unpublished: the relay publishes them).`)
  console.log('API keys (dev only):', CUSTOMERS.filter((c) => c.apiKey).map((c) => `${c.id}=${c.apiKey}`).join('  '))
}

try {
  await main()
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
  redis.disconnect()
}
