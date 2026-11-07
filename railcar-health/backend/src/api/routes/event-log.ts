/**
 * Event timelines read straight from the event store: a car (every event tagged
 * with it, across its car stream, its cases and its trips), a case (its stream
 * plus the events in other streams that caused it or that it caused), and one
 * event with its causation chain. Each event shows its schema version (and the
 * version it was stored at, if it was upcast), event time vs recorded time, and
 * its correlation and causation ids.
 */
import { Router } from 'express'
import { requireAuth, type SessionUser } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { streamIds } from '../../events/catalog.js'
import { describeEvent } from '../../events/describe.js'
import { toEnvelope, type EventEnvelope, type StoredEventRow } from '../../events/envelope.js'
import { readEvent } from '../../events/store.js'
import { loadCase } from '../../domain/repository.js'

export const eventLogRouter = Router()
eventLogRouter.use(requireAuth)

export function eventDto(e: EventEnvelope, causeType: string | null = null) {
  return { ...e, summary: describeEvent(e), upcast: e.storedVersion !== e.version, causeType }
}

/** Envelopes plus the type of each one's cause (which may sit in a stream the timeline doesn't show). */
async function withCauses(rows: StoredEventRow[]) {
  const envelopes = rows.map(toEnvelope)
  const ids = [...new Set(envelopes.map((e) => e.causationId).filter((id): id is string => id !== null))]
  const { rows: causes } = ids.length
    ? await pool.query<{ event_id: string; type: string }>('SELECT event_id, type FROM events WHERE event_id = ANY($1::uuid[])', [ids])
    : { rows: [] }
  const types = new Map(causes.map((c) => [c.event_id, c.type]))
  return envelopes.map((e) => eventDto(e, e.causationId ? (types.get(e.causationId) ?? null) : null))
}

async function canSeeCase(user: SessionUser, caseId: string): Promise<boolean> {
  if (user.role !== 'yard') return true
  const s = await loadCase(pool, caseId)
  return s.yardId === user.yardId || s.workOrder?.yardId === user.yardId || s.hold?.yardId === user.yardId
}


eventLogRouter.get(
  '/cars/:carId',
  asyncHandler(async (req, res) => {
    const limit = Math.min(500, Number(req.query.limit ?? 300))
    const result = await pool.query<StoredEventRow>(
      `SELECT * FROM (SELECT * FROM events WHERE tags @> ARRAY[$1]::text[] ORDER BY global_position DESC LIMIT $2) e ORDER BY global_position`,
      [`car:${req.params.carId}`, limit],
    )
    res.json({ subject: { kind: 'car', id: req.params.carId, streamId: streamIds.car(req.params.carId) }, events: await withCauses(result.rows) })
  }),
)

eventLogRouter.get(
  '/cases/:caseId',
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId
    if (!/^[0-9a-f-]{36}$/.test(caseId)) throw notFound('Case')
    if (!(await canSeeCase(req.user!, caseId))) throw notFound('Case')
    const streamId = streamIds.case(caseId)
    // The case stream, the events in other streams that directly caused one of its events, and
    // the events elsewhere that one of its events caused (e.g. a repair -> ComponentReplaced).
    const result = await pool.query<StoredEventRow>(
      `WITH c AS (SELECT * FROM events WHERE stream_id = $1)
       SELECT * FROM c
       UNION SELECT e.* FROM events e WHERE e.event_id IN (SELECT causation_id FROM c WHERE causation_id IS NOT NULL) AND e.stream_id <> $1
       UNION SELECT e.* FROM events e WHERE e.causation_id IN (SELECT event_id FROM c) AND e.stream_id <> $1
       ORDER BY global_position`,
      [streamId],
    )
    if (result.rows.length === 0) throw notFound('Case')
    const s = await loadCase(pool, caseId)
    res.json({
      subject: { kind: 'case', id: caseId, streamId, carId: s.carId, tripId: s.tripId, status: s.status, tier: s.tier, version: s.version, caseType: s.caseType },
      events: await withCauses(result.rows),
    })
  }),
)

eventLogRouter.get(
  '/events/:eventId',
  asyncHandler(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.eventId)) throw notFound('Event')
    const found = await readEvent(pool, req.params.eventId)
    if (!found) throw notFound('Event')
    if (found.envelope.streamType === 'case' && !(await canSeeCase(req.user!, found.envelope.streamId.slice(5)))) throw notFound('Event')
    // Causation chain: walk up to the root (at most 12 hops), then the events this one caused.
    const ancestors: EventEnvelope[] = []
    let cause = found.envelope.causationId
    while (cause && ancestors.length < 12) {
      const parent = await readEvent(pool, cause)
      if (!parent) break
      ancestors.unshift(parent.envelope)
      cause = parent.envelope.causationId
    }
    const children = await pool.query<StoredEventRow>('SELECT * FROM events WHERE causation_id = $1 ORDER BY global_position', [found.envelope.eventId])
    const correlated = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM events WHERE correlation_id = $1', [found.envelope.correlationId])
    res.json({
      event: eventDto(found.envelope),
      stored: { version: found.stored.version, payload: found.stored.payload },
      ancestors: ancestors.map((a) => eventDto(a)),
      children: await withCauses(children.rows),
      correlatedCount: correlated.rows[0].n,
    })
  }),
)
