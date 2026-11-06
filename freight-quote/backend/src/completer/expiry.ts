/**
 * Expiry sweeper: open quotes past valid_until become `expired`, with a
 * QuoteExpired event in the same transaction. SKIP LOCKED lets several
 * completers sweep without blocking each other, and the status guard makes a
 * quote expire exactly once. Booking also checks valid_until itself, so a
 * quote is never bookable late just because the sweeper hasn't run.
 * @module completer/expiry
 */
import { withTransaction } from '../shared/db.js'
import { appendEvents } from '../shared/event-store.js'
import { quoteStream } from '../shared/events.js'

export async function expireDueQuotes(limit = 100): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `WITH due AS (
         SELECT id FROM quotes WHERE status = 'open' AND valid_until < now() ORDER BY valid_until LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE quotes q SET status = 'expired', version = q.version + 1, updated_at = now()
       FROM due WHERE q.id = due.id RETURNING q.*`,
      [limit],
    )
    for (const q of rows) {
      await appendEvents(
        client,
        [
          {
            type: 'QuoteExpired',
            streamId: quoteStream(q.id),
            correlationId: q.correlation_id,
            occurredAt: new Date(q.valid_until),
            payload: { quote_id: q.id, customer_id: q.customer_id, kind: q.kind, valid_until: new Date(q.valid_until).toISOString() },
          },
        ],
        'expiry-sweeper',
      )
    }
    return rows.length
  })
}
