/**
 * The synchronous quote path and bookings.
 *
 * POST /quotes, in order:
 *   validate → classify (portal / api / api_requote) → per-customer rate limit
 *   → admission (shed by class) → idempotency replay → fan-out under the
 *   deadline → compose → one transaction: quote row + QuoteRequested +
 *   QuoteIssued in the outbox → 201 (firm) or 202 (indicative; firm follows).
 *
 * Under overload, everything before the idempotency lookup touches only
 * memory and Valkey, so shedding a request never costs a database query.
 * @module api/services/quotes
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { pool, withTransaction, type Queryable } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { appendEvents } from '../../shared/event-store.js'
import { quoteStream } from '../../shared/events.js'
import { composeQuote, provenanceOf } from '../../shared/compose.js'
import { fetchComponents, type FanoutContext } from '../../shared/fanout.js'
import { getSettings } from '../../shared/settings.js'
import { takeToken } from '../../shared/rate-limit.js'
import { quoteDuration, shedTotal } from '../../shared/metrics.js'
import { SingleFlight } from '../../shared/resilience.js'
import { commodityOf, laneOf, type ClientClass } from '../../shared/reference.js'
import { DEPENDENCIES, type QuoteView } from '../../shared/domain.js'
import { admits, REQUOTE_WINDOW_SECONDS, retryAfterSeconds } from './admission.js'
import type { OpsStats } from './ops-stats.js'

export const quoteRequestSchema = z.object({
  origin: z.string().length(3),
  destination: z.string().length(3),
  commodity: z.string().min(2).max(16),
  equipment: z.enum(['COVERED_HOPPER', 'BOXCAR', 'CENTERBEAM', 'TANK', 'GONDOLA']),
  quantity: z.number().int().min(1).max(200),
  shipWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Deliver the firm quote to the customer's registered webhook. A URL is never accepted here. */
  callback: z.boolean().default(false),
})
export type QuoteRequestBody = z.infer<typeof quoteRequestSchema>

export interface QuoteResponse {
  status: number
  body: unknown
  headers: Record<string, string>
}

export interface SubmitInput {
  customerId: string
  baseClass: 'portal' | 'api'
  idempotencyKey: string
  body: unknown
  requestedDeadlineMs: number | null
  correlationId: string
}

const contractCache = new Map<string, { value: { id: string; version: number } | null; at: number }>()
const customerCache = new Map<string, { rateLimit: number | null; at: number }>()

async function contractFor(customerId: string, b: QuoteRequestBody): Promise<{ id: string; version: number } | null> {
  const key = `${customerId}:${b.origin}:${b.destination}:${b.commodity}:${b.equipment}`
  const hit = contractCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const { rows } = await pool.query<{ id: string; version: number }>(
    'SELECT id, version FROM contracts WHERE customer_id = $1 AND origin = $2 AND destination = $3 AND commodity = $4 AND equipment = $5',
    [customerId, b.origin, b.destination, b.commodity, b.equipment],
  )
  const value = rows[0] ?? null
  contractCache.set(key, { value, at: Date.now() })
  return value
}

async function customerRateLimit(customerId: string): Promise<number | null> {
  const hit = customerCache.get(customerId)
  if (hit && Date.now() - hit.at < 60_000) return hit.rateLimit
  const { rows } = await pool.query<{ rate_limit_per_min: number | null }>('SELECT rate_limit_per_min FROM customers WHERE id = $1', [customerId])
  const rateLimit = rows[0]?.rate_limit_per_min ?? null
  customerCache.set(customerId, { rateLimit, at: Date.now() })
  return rateLimit
}

export function requestHashOf(b: QuoteRequestBody): string {
  const canonical = [b.origin, b.destination, b.commodity, b.equipment, b.quantity, b.shipWeek, b.callback].join('|')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

function inputsHashOf(b: QuoteRequestBody): string {
  return createHash('sha256').update([b.origin, b.destination, b.commodity, b.equipment, b.quantity, b.shipWeek].join('|')).digest('hex').slice(0, 24)
}

export class QuoteService {
  private readonly keyFlight = new SingleFlight()

  constructor(
    private readonly redis: Redis,
    private readonly fanout: FanoutContext,
    private readonly stats: OpsStats,
  ) {}

  async submit(input: SubmitInput): Promise<QuoteResponse> {
    const startedAt = Date.now()
    const settings = await getSettings(this.redis)
    this.stats.applySettings(settings)
    for (const d of DEPENDENCIES) this.fanout.hedgeBudgets[d].setPct(settings.hedging.budgetPct)

    const body = quoteRequestSchema.parse(input.body)
    const lane = laneOf(body.origin, body.destination)
    if (!lane) throw new HttpError(422, 'UNKNOWN_LANE', `No service from ${body.origin} to ${body.destination}`)
    const commodity = commodityOf(body.commodity)
    if (!commodity) throw new HttpError(422, 'UNKNOWN_COMMODITY', `Unknown commodity ${body.commodity}`)
    if (!commodity.equipment.includes(body.equipment)) {
      throw new HttpError(422, 'EQUIPMENT_MISMATCH', `${commodity.name} moves in ${commodity.equipment.join(' or ')}`)
    }

    // Classify: an integration asking for the same inputs again within the window is re-quoting.
    let cls: ClientClass = input.baseClass
    if (input.baseClass === 'api') {
      const first = await this.redis.set(`fq:recent:${input.customerId}:${inputsHashOf(body)}`, '1', 'EX', REQUOTE_WINDOW_SECONDS, 'NX')
      if (first === null) cls = 'api_requote'
    }
    const done = (outcome: Parameters<OpsStats['quote']>[1]) => {
      const ms = Date.now() - startedAt
      this.stats.quote(cls, outcome, ms)
      quoteDuration.observe({ client_class: cls, outcome }, ms / 1000)
    }

    if (settings.rateLimits.enabled) {
      const perMinute = (await customerRateLimit(input.customerId)) ?? (input.baseClass === 'portal' ? settings.rateLimits.portalPerMinute : settings.rateLimits.apiPerMinute)
      const decision = await takeToken(this.redis, input.customerId, perMinute)
      if (!decision.allowed) {
        done('rate_limited')
        shedTotal.inc({ client_class: cls, reason: 'rate_limited' })
        return {
          status: 429,
          headers: { 'Retry-After': String(decision.retryAfterSeconds) },
          body: { error: { code: 'RATE_LIMITED', message: `Rate limit of ${perMinute} quotes/minute exceeded`, details: { clientClass: cls } } },
        }
      }
    }

    if (!admits(this.stats.inflight, cls, settings.shedding)) {
      done('shed')
      shedTotal.inc({ client_class: cls, reason: 'shed' })
      return {
        status: 503,
        headers: { 'Retry-After': String(retryAfterSeconds(cls)) },
        body: { error: { code: 'SHED', message: 'Quote service is shedding load; retry later', details: { clientClass: cls, inflight: this.stats.inflight } } },
      }
    }

    this.stats.inflight += 1
    try {
      const requestHash = requestHashOf(body)
      const existing = await findByIdempotencyKey(pool, input.customerId, input.idempotencyKey)
      if (existing) {
        done('replayed')
        return replay(existing, requestHash)
      }
      const flight = this.keyFlight.do(`${input.customerId}:${input.idempotencyKey}`, () =>
        this.issue(input, body, cls, requestHash, lane.miles, startedAt, settings.deadlineMs),
      )
      const result = await flight.promise
      const outcome = result.status === 201 ? 'firm' : result.status === 202 ? 'indicative' : result.status === 503 ? 'unavailable' : 'replayed'
      done(flight.shared ? 'replayed' : outcome)
      return result
    } finally {
      this.stats.inflight -= 1
    }
  }

  private async issue(input: SubmitInput, body: QuoteRequestBody, cls: ClientClass, requestHash: string, laneMiles: number, startedAt: number, deadlineMs: number): Promise<QuoteResponse> {
    const settings = await getSettings(this.redis)
    const contract = await contractFor(input.customerId, body)
    const effectiveDeadline = Math.min(deadlineMs, input.requestedDeadlineMs ?? Number.POSITIVE_INFINITY)
    const results = await fetchComponents(
      { customerId: input.customerId, contractId: contract?.id ?? null, ...body },
      {
        deadlineAt: startedAt + effectiveDeadline,
        budgets: settings.budgets,
        propagateDeadline: settings.propagateDeadline,
        hedgeDeps: settings.hedging.enabled ? settings.hedging.deps : [],
        coalescing: settings.coalescing,
        cacheFirst: true,
      },
      this.fanout,
    )
    const now = new Date()
    const outcome = composeQuote({ quantity: body.quantity, laneMiles, results, now, rulesVersion: config.quote.rulesVersion, staleness: settings.staleness, validity: settings.validity })
    if (outcome.kind === 'unavailable') {
      return {
        status: 503,
        headers: { 'Retry-After': '2' },
        body: { error: { code: 'PRICING_UNAVAILABLE', message: `No quote: ${outcome.reason}`, details: { failed: outcome.failed } } },
      }
    }

    const quoteId = randomUUID()
    const latencyMs = Date.now() - startedAt
    const inserted = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO quotes (id, customer_id, idempotency_key, request_hash, client_class, origin, destination, commodity, equipment, quantity, ship_week,
           kind, firm_status, total_cents, band_low_cents, band_high_cents, currency, inputs, components, indicative_snapshot, valid_until, callback,
           deadline_ms, latency_ms, correlation_id, firm_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (customer_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          quoteId, input.customerId, input.idempotencyKey, requestHash, cls, body.origin, body.destination, body.commodity, body.equipment, body.quantity, body.shipWeek,
          outcome.kind, outcome.kind === 'firm' ? 'not_needed' : 'pending', outcome.totalCents, outcome.band.lowCents, outcome.band.highCents, config.quote.currency,
          JSON.stringify(outcome.inputs), JSON.stringify(outcome.components), outcome.kind === 'indicative' ? JSON.stringify({ totalCents: outcome.totalCents, band: outcome.band, components: outcome.components }) : null,
          outcome.validUntil, body.callback, effectiveDeadline, latencyMs, input.correlationId, outcome.kind === 'firm' ? now : null,
        ],
      )
      if (rows.length === 0) return null
      const requested = await appendEvents(
        client,
        [
          {
            type: 'QuoteRequested',
            streamId: quoteStream(quoteId),
            correlationId: input.correlationId,
            occurredAt: new Date(startedAt),
            payload: {
              quote_id: quoteId, customer_id: input.customerId, client_class: cls, origin: body.origin, destination: body.destination, commodity: body.commodity,
              equipment: body.equipment, quantity: body.quantity, ship_week: body.shipWeek, idempotency_key: input.idempotencyKey, deadline_ms: effectiveDeadline,
              needs_firm: outcome.kind === 'indicative',
            },
          },
        ],
        'quote-api',
      )
      await appendEvents(
        client,
        [
          {
            type: 'QuoteIssued',
            streamId: quoteStream(quoteId),
            correlationId: input.correlationId,
            causationId: requested[0].event_id,
            occurredAt: now,
            payload: {
              quote_id: quoteId, customer_id: input.customerId, kind: outcome.kind, revision: 1, total_cents: outcome.totalCents, currency: config.quote.currency,
              valid_until: outcome.validUntil.toISOString(), tariff_version: outcome.inputs.tariffVersion !== null ? `v${outcome.inputs.tariffVersion}` : null,
              surcharge_date: outcome.inputs.fuelSurchargeDate, reason: 'initial', client_class: cls, latency_ms: latencyMs,
              price_components: provenanceOf(outcome.components),
            },
          },
        ],
        'quote-api',
      )
      return rows[0]
    })

    if (!inserted) {
      // Another instance won the race for this idempotency key.
      const existing = await findByIdempotencyKey(pool, input.customerId, input.idempotencyKey)
      if (!existing) throw new HttpError(500, 'IDEMPOTENCY_RACE', 'Concurrent request vanished')
      return replay(existing, requestHash)
    }
    const view = toView(inserted, null)
    if (view.kind === 'firm') return { status: 201, headers: { Location: `/api/v1/quotes/${quoteId}` }, body: { quote: view } }
    return {
      status: 202,
      headers: { Location: `/api/v1/quotes/${quoteId}`, 'Retry-After': '2' },
      body: { quote: view, firm: { status: 'pending', poll: `/api/v1/quotes/${quoteId}`, callback: body.callback, unconfirmed: outcome.unconfirmed } },
    }
  }

  async book(quoteId: string, customerId: string | null, staff: boolean, idempotencyKey: string): Promise<QuoteResponse> {
    return withTransaction(async (client): Promise<QuoteResponse> => {
      const { rows } = await client.query('SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [quoteId])
      const q = rows[0]
      if (!q || (!staff && q.customer_id !== customerId)) throw notFound('Quote')
      if (staff) throw new HttpError(403, 'CUSTOMER_ONLY', 'Only the customer can book its quote')
      const prior = await client.query('SELECT * FROM bookings WHERE quote_id = $1', [quoteId])
      if (prior.rows[0]) {
        if (prior.rows[0].idempotency_key === idempotencyKey) return { status: 200, headers: { 'Idempotent-Replayed': 'true' }, body: { booking: bookingView(prior.rows[0]), quote: toView(q, prior.rows[0]) } }
        throw new HttpError(409, 'ALREADY_BOOKED', 'This quote is already booked')
      }
      if (q.kind !== 'firm') throw new HttpError(409, 'NOT_FIRM', 'Indicative quotes are estimates and cannot be booked; wait for the firm quote')
      if (q.status === 'expired' || new Date(q.valid_until).getTime() <= Date.now()) {
        throw new HttpError(409, 'QUOTE_EXPIRED', 'This quote has expired; request a new one at current prices')
      }
      const inputs = q.inputs as QuoteView['inputs']
      const current = inputs.tariffId ? await client.query<{ version: number }>('SELECT version FROM tariff_current WHERE tariff_id = $1', [inputs.tariffId]) : { rows: [] }
      const currentVersion = current.rows[0]?.version ?? null
      const { rows: booked } = await client.query(
        `INSERT INTO bookings (quote_id, customer_id, idempotency_key, honored_total_cents, honored_inputs, current_tariff_version)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [quoteId, q.customer_id, idempotencyKey, q.total_cents, JSON.stringify(inputs), currentVersion],
      )
      const { rows: updated } = await client.query(`UPDATE quotes SET status = 'booked', version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [quoteId])
      await appendEvents(
        client,
        [
          {
            type: 'QuoteBooked',
            streamId: quoteStream(quoteId),
            correlationId: q.correlation_id,
            payload: {
              quote_id: quoteId, booking_id: booked[0].id, customer_id: q.customer_id, kind: 'firm', honored_total_cents: Number(q.total_cents),
              honored_tariff_version: inputs.tariffVersion !== null ? `v${inputs.tariffVersion}` : null,
              current_tariff_version: currentVersion !== null ? `v${currentVersion}` : null,
            },
          },
        ],
        'quote-api',
      )
      return { status: 201, headers: {}, body: { booking: bookingView(booked[0]), quote: toView(updated[0], booked[0]) } }
    })
  }
}

async function findByIdempotencyKey(db: Queryable, customerId: string, key: string): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query('SELECT * FROM quotes WHERE customer_id = $1 AND idempotency_key = $2', [customerId, key])
  return rows[0] ?? null
}

function replay(row: Record<string, unknown>, requestHash: string): QuoteResponse {
  if (row.request_hash !== requestHash) {
    throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request')
  }
  const view = toView(row, null)
  return { status: 200, headers: { 'Idempotent-Replayed': 'true', Location: `/api/v1/quotes/${view.id}` }, body: { quote: view, replayed: true } }
}

export function bookingView(row: Record<string, unknown>) {
  return { id: row.id as string, honoredTotalCents: Number(row.honored_total_cents), createdAt: new Date(row.created_at as string).toISOString(), currentTariffVersion: row.current_tariff_version as number | null }
}

export function toView(row: Record<string, unknown>, booking: Record<string, unknown> | null, customerName?: string): QuoteView {
  const validUntil = new Date(row.valid_until as string)
  const kind = row.kind as QuoteView['kind']
  const status = row.status as QuoteView['status']
  return {
    id: row.id as string,
    customerId: row.customer_id as string,
    customerName,
    clientClass: row.client_class as ClientClass,
    origin: row.origin as string,
    destination: row.destination as string,
    commodity: row.commodity as string,
    equipment: row.equipment as QuoteView['equipment'],
    quantity: row.quantity as number,
    shipWeek: row.ship_week instanceof Date ? row.ship_week.toISOString().slice(0, 10) : String(row.ship_week),
    kind,
    firmStatus: row.firm_status as QuoteView['firmStatus'],
    status,
    revision: row.revision as number,
    totalCents: Number(row.total_cents),
    currency: row.currency as string,
    band: { lowCents: Number(row.band_low_cents), highCents: Number(row.band_high_cents) },
    components: row.components as QuoteView['components'],
    inputs: row.inputs as QuoteView['inputs'],
    validUntil: validUntil.toISOString(),
    bookable: kind === 'firm' && status === 'open' && validUntil.getTime() > Date.now(),
    createdAt: new Date(row.created_at as string).toISOString(),
    firmAt: row.firm_at ? new Date(row.firm_at as string).toISOString() : null,
    latencyMs: row.latency_ms as number,
    correlationId: row.correlation_id as string,
    callback: row.callback as boolean,
    booking: booking ? bookingView(booking) : null,
  }
}

export async function loadQuote(db: Queryable, id: string): Promise<{ row: Record<string, unknown>; booking: Record<string, unknown> | null; customerName: string } | null> {
  const { rows } = await db.query(
    `SELECT q.*, c.name AS customer_name, row_to_json(b) AS booking FROM quotes q JOIN customers c ON c.id = q.customer_id
     LEFT JOIN bookings b ON b.quote_id = q.id WHERE q.id = $1`,
    [id],
  )
  if (!rows[0]) return null
  return { row: rows[0], booking: rows[0].booking, customerName: rows[0].customer_name }
}

