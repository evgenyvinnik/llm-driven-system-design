/**
 * Async firm-quote completion: a consumer of QuoteRequested.
 *
 * Idempotency is by quote state, re-checked under a row lock, plus a
 * processed_events row in the same transaction. A redelivered QuoteRequested
 * finds the quote already firm (or closed) and does nothing, so a completer
 * killed after its commit but before XACK never issues a second firm quote.
 *
 * A dependency that is still down is a transient failure: the message stays
 * pending and is retried with backoff, then dead-lettered (the quote shows
 * "firm delayed"). A redrive after the dependency recovers completes it.
 * @module completer/firm
 */
import type { Redis } from 'ioredis'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { appendEvents } from '../shared/event-store.js'
import { quoteStream, type DomainEvent } from '../shared/events.js'
import { composeQuote, provenanceOf } from '../shared/compose.js'
import { fetchComponents, type FanoutContext } from '../shared/fanout.js'
import { getSettings } from '../shared/settings.js'
import { PermanentError } from '../shared/consumer.js'
import { laneOf } from '../shared/reference.js'
import { DEPENDENCIES, type Dependency } from '../shared/domain.js'

export type CompletionPlan = 'complete' | 'not_needed' | 'already_firm' | 'closed'

/** Decides what a (possibly redelivered) QuoteRequested should do, from the quote's current state. */
export function planCompletion(needsFirm: boolean, quote: { kind: string; status: string } | null): CompletionPlan {
  if (!needsFirm) return 'not_needed'
  if (!quote) throw new PermanentError('quote not found for QuoteRequested')
  if (quote.kind === 'firm') return 'already_firm'
  if (quote.status !== 'open') return 'closed'
  return 'complete'
}

export class StillUnconfirmedError extends Error {
  constructor(readonly unconfirmed: Dependency[]) {
    super(`firm quote not possible yet: ${unconfirmed.join(', ')} unavailable`)
    this.name = 'StillUnconfirmedError'
  }
}

export async function completeFirmQuote(event: DomainEvent<'QuoteRequested'>, deliveries: number, redis: Redis, fanout: FanoutContext): Promise<CompletionPlan> {
  const p = event.payload
  const { rows } = await pool.query('SELECT * FROM quotes WHERE id = $1', [p.quote_id])
  const plan = planCompletion(p.needs_firm, rows[0] ?? null)
  if (plan !== 'complete') return plan
  const quote = rows[0]

  const settings = await getSettings(redis)
  const budget = config.completer.dependencyBudgetMs
  const contractId = (quote.inputs as { contractId: string | null }).contractId
  const results = await fetchComponents(
    { customerId: p.customer_id, contractId, origin: p.origin, destination: p.destination, commodity: p.commodity, equipment: p.equipment, quantity: p.quantity, shipWeek: p.ship_week },
    {
      deadlineAt: Date.now() + budget,
      budgets: Object.fromEntries(DEPENDENCIES.map((d) => [d, budget])) as Record<Dependency, number>,
      propagateDeadline: true,
      hedgeDeps: [],
      coalescing: true,
      cacheFirst: true,
    },
    fanout,
  )
  const lane = laneOf(p.origin, p.destination)
  const now = new Date()
  const outcome = composeQuote({ quantity: p.quantity, laneMiles: lane?.miles ?? 0, results, now, rulesVersion: config.quote.rulesVersion, staleness: settings.staleness, validity: settings.validity })
  if (outcome.kind !== 'firm') {
    const unconfirmed = outcome.kind === 'unavailable' ? outcome.failed : outcome.unconfirmed
    await pool.query(
      `UPDATE quotes SET firm_attempts = GREATEST(firm_attempts, $2), firm_status = CASE WHEN $2 >= $3 THEN 'delayed' ELSE firm_status END, updated_at = now()
       WHERE id = $1 AND kind = 'indicative'`,
      [p.quote_id, Math.max(deliveries, Number(quote.firm_attempts) + 1), config.streams.maxDeliveries],
    )
    throw new StillUnconfirmedError(unconfirmed)
  }

  return withTransaction(async (client) => {
    const locked = await client.query('SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [p.quote_id])
    const again = planCompletion(true, locked.rows[0] ?? null)
    if (again !== 'complete') return again
    const fresh = await client.query('INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['completer', event.event_id])
    if (fresh.rowCount === 0) return 'already_firm'
    const q = locked.rows[0]
    const attempts = Math.max(deliveries, Number(q.firm_attempts) + 1)
    const { rows: updated } = await client.query(
      `UPDATE quotes SET kind = 'firm', firm_status = 'completed', total_cents = $2, band_low_cents = $2, band_high_cents = $2,
         inputs = $3, components = $4, valid_until = $5, revision = revision + 1, version = version + 1, firm_at = now(),
         firm_attempts = GREATEST(firm_attempts, $6), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [p.quote_id, outcome.totalCents, JSON.stringify(outcome.inputs), JSON.stringify(outcome.components), outcome.validUntil, attempts],
    )
    const u = updated[0]
    const completionMs = Math.max(0, now.getTime() - new Date(event.occurred_at).getTime())
    const tariffVersion = outcome.inputs.tariffVersion !== null ? `v${outcome.inputs.tariffVersion}` : null
    const [completed] = await appendEvents(
      client,
      [
        {
          type: 'FirmQuoteCompleted',
          streamId: quoteStream(p.quote_id),
          correlationId: event.correlation_id,
          causationId: event.event_id,
          payload: {
            quote_id: p.quote_id, customer_id: p.customer_id, total_cents: outcome.totalCents, indicative_total_cents: Number(q.total_cents),
            valid_until: outcome.validUntil.toISOString(), tariff_version: tariffVersion, surcharge_date: outcome.inputs.fuelSurchargeDate,
            attempts, completion_ms: completionMs,
          },
        },
      ],
      'firm-completer',
    )
    await appendEvents(
      client,
      [
        {
          type: 'QuoteIssued',
          streamId: quoteStream(p.quote_id),
          correlationId: event.correlation_id,
          causationId: completed.event_id,
          payload: {
            quote_id: p.quote_id, customer_id: p.customer_id, kind: 'firm', revision: u.revision as number, total_cents: outcome.totalCents, currency: config.quote.currency,
            valid_until: outcome.validUntil.toISOString(), tariff_version: tariffVersion, surcharge_date: outcome.inputs.fuelSurchargeDate,
            reason: 'firm_completed', client_class: p.client_class, latency_ms: null, price_components: provenanceOf(outcome.components),
          },
        },
      ],
      'firm-completer',
    )
    return 'complete' as const
  })
}
