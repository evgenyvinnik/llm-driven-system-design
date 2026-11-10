/**
 * Cancellation. The race with completion is decided by one guarded UPDATE
 * (queued|running → cancelled). If it wins:
 *   - still in the queue → removed atomically, full refund here;
 *   - already claimed by the dispatcher → a cancel message tells it to stop
 *     the backend; the dispatcher bills tokens generated so far and refunds the rest.
 * The winner writes the one terminal event to the request's event log.
 * If it loses, the request already reached a terminal state, and the caller
 * gets that state: whichever transition won is what everyone observes.
 * @module gateway/cancel
 */
import { keys, redis, runScript } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { cancellations } from '../shared/metrics.js'
import { appendEvent, finalizeUnstarted, getRequest, loadJob, transition, type RequestRow } from '../shared/requests.js'

export type CancelReason = 'client_request' | 'client_disconnected' | 'sync_timeout' | 'console'

export interface CancelResult {
  won: boolean
  row: RequestRow | null
}

export async function cancelRequest(id: string, reason: CancelReason, orgIds?: string[]): Promise<CancelResult> {
  const existing = await getRequest(pool, id, orgIds)
  if (!existing) return { won: false, row: null }
  const row = await transition(pool, id, 'cancelled', { cancel_reason: reason, finished_at: new Date() }, existing.org_id)
  if (!row) {
    cancellations.inc({ reason, won: 'false' })
    return { won: false, row: await getRequest(pool, id) }
  }
  cancellations.inc({ reason, won: 'true' })
  const job = await loadJob(id)
  const cls = row.priority_class
  const removed = await runScript<number>(
    'UNQUEUE',
    [keys.age(cls), keys.deadline(cls), keys.tenantQueue(cls, row.org_id), keys.tenants(cls), keys.job(id)],
    [id, row.org_id],
  )
  if (removed === 1 && job) {
    await finalizeUnstarted(job, 'cancelled')
  } else {
    await redis.publish(keys.cancelChannel, JSON.stringify({ id, reason }))
  }
  await appendEvent(id, 'cancelled', { reason, wasQueued: removed === 1 })
  return { won: true, row }
}
