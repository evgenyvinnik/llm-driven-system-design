/**
 * Moving deliveries into the queue, and taking endpoints out of service.
 *
 * Every path into RabbitMQ (first attempt, scheduled retry, replay, recovery)
 * goes through `enqueue`: in ONE transaction it flips the delivery to
 * `queued`, bumps `dispatch_seq` and writes an outbox row. The publisher
 * relays outbox rows to RabbitMQ afterwards. A crash anywhere leaves either
 * no change, or a committed outbox row that will be published; never a
 * queued delivery with no ticket on the way.
 * @module shared/dispatch
 */
import type pg from 'pg'
import { config } from './config.js'
import { endpointsDisabled } from './metrics.js'

export const OUTBOX_CHANNEL = 'webhook_outbox'

/** Wakes the publisher. NOTIFY inside a transaction is delivered at commit, so it never runs ahead of the data. */
export async function notifyOutbox(client: pg.PoolClient): Promise<void> {
  await client.query(`SELECT pg_notify('${OUTBOX_CHANNEL}', '')`)
}

/** Writes outbox rows for deliveries already set to `queued` with the given dispatch numbers. */
export async function writeOutbox(client: pg.PoolClient, rows: { id: string; dispatchSeq: number }[]): Promise<void> {
  if (rows.length === 0) return
  await client.query('INSERT INTO outbox (delivery_id, dispatch_seq) SELECT * FROM unnest($1::text[], $2::int[])', [
    rows.map((r) => r.id),
    rows.map((r) => r.dispatchSeq),
  ])
  await notifyOutbox(client)
}

/**
 * Re-queues existing deliveries (scheduler, replay, recovery). Only rows whose
 * state is in `fromStates` move; the rest are left alone. Returns the moved ids.
 */
export async function enqueue(
  client: pg.PoolClient,
  ids: string[],
  fromStates: string[],
  opts: { replay?: boolean } = {},
): Promise<{ id: string; dispatchSeq: number }[]> {
  if (ids.length === 0) return []
  const replaySet = opts.replay
    ? `, replay_count = replay_count + 1, retry_deadline = now() + make_interval(secs => ${config.delivery.retryHorizonSeconds}),
       window_started_at = NULL, delivered_at = NULL`
    : ''
  const { rows } = await client.query<{ id: string; dispatch_seq: number }>(
    `UPDATE deliveries
        SET state = 'queued', dispatch_seq = dispatch_seq + 1, queued_at = now(), next_attempt_at = NULL,
            lease_token = NULL, lease_until = NULL, claimed_by = NULL, updated_at = now() ${replaySet}
      WHERE id = ANY($1) AND state = ANY($2)
      RETURNING id, dispatch_seq`,
    [ids, fromStates],
  )
  const moved = rows.map((r) => ({ id: r.id, dispatchSeq: r.dispatch_seq }))
  await writeOutbox(client, moved)
  return moved
}

const REASON_TEXT: Record<string, string> = {
  retry_horizon_exhausted: 'kept failing for the whole retry window',
  gone_410: 'answered 410 Gone, which means "stop sending"',
  ssrf_blocked: 'resolved to a private or internal address, which is never allowed',
  invalid_url: 'has a URL that cannot be used',
  manual: 'was disabled by a member of your team',
}

/**
 * Disables an endpoint, fails its waiting deliveries (they can be replayed
 * after re-enabling) and notifies the org. Idempotent: an endpoint that is
 * already disabled is left as it is and no second notification is written.
 */
export async function disableEndpoint(client: pg.PoolClient, endpointId: string, reason: string, detail: string): Promise<boolean> {
  const { rows } = await client.query<{ org_id: string; url: string; description: string }>(
    `UPDATE endpoints SET status = 'disabled', disabled_reason = $2, disabled_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING org_id, url, description`,
    [endpointId, reason],
  )
  const ep = rows[0]
  if (!ep) return false
  await client.query(
    `UPDATE deliveries SET state = 'failed', last_error_class = 'endpoint_disabled', next_attempt_at = NULL, updated_at = now()
      WHERE endpoint_id = $1 AND state IN ('scheduled', 'queued')`,
    [endpointId],
  )
  if (reason !== 'manual') {
    endpointsDisabled.inc({ reason })
    await client.query(
      `INSERT INTO notifications (org_id, endpoint_id, kind, title, body) VALUES ($1, $2, 'endpoint_disabled', $3, $4)`,
      [
        ep.org_id,
        endpointId,
        `Endpoint disabled: ${ep.description || ep.url}`,
        `${ep.url} ${REASON_TEXT[reason] ?? reason}. ${detail} Deliveries are paused and the waiting ones are marked failed. Fix the receiver, re-enable the endpoint, then replay failed deliveries.`,
      ],
    )
  }
  return true
}
