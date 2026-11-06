/**
 * Ops / Streams (reliability engineers): consumer lag and pending per group,
 * projection staleness, DLQ depth and contents with redrive, events per second,
 * the relay's position, the durable timers, and fault injection for demos.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireRole } from '../../shared/auth.js'
import { redis } from '../../shared/cache.js'
import { nowMs } from '../../shared/clock.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { CATALOG } from '../../events/catalog.js'
import { listDeadLetters, redrive } from '../../events/dlq.js'
import { toEnvelope, type StoredEventRow } from '../../events/envelope.js'
import { listFaults, setFault } from '../../events/faults.js'
import { opsOverview } from '../../events/ops.js'
import { GROUPS } from '../../events/topology.js'
import { eventDto } from './event-log.js'

export const opsRouter = Router()
opsRouter.use(requireRole('admin'))

opsRouter.get('/streams', asyncHandler(async (_req, res) => res.json({ ...(await opsOverview(redis, pool, nowMs())), faults: await listFaults(redis) })))

opsRouter.get(
  '/dlq',
  asyncHandler(async (_req, res) => {
    const entries = await listDeadLetters(redis, 200)
    res.json({
      entries: entries.map((d) => {
        try {
          const row = JSON.parse(d.event) as StoredEventRow
          return { ...d, event: { raw: row, upcast: eventDto(toEnvelope(row)) } }
        } catch {
          return { ...d, event: { raw: d.event, upcast: null } }
        }
      }),
    })
  }),
)

opsRouter.post(
  '/dlq/:id/redrive',
  asyncHandler(async (req, res) => {
    const result = await redrive(redis, req.params.id)
    if (!result) throw notFound('Dead letter')
    res.json({ redriven: req.params.id, newMessageId: result.newMessageId, group: result.entry.group, streamKey: result.entry.streamKey })
  }),
)

opsRouter.post(
  '/dlq/redrive-all',
  asyncHandler(async (req, res) => {
    const group = typeof req.query.group === 'string' ? req.query.group : null
    const entries = (await listDeadLetters(redis, 1000)).filter((d) => !group || d.group === group)
    for (const d of entries) await redrive(redis, d.id)
    res.json({ redriven: entries.length })
  }),
)

const faultSchema = z.object({ match: z.string().max(200), mode: z.enum(['transient', 'permanent', 'crash_after_commit']).default('transient'), note: z.string().max(200).optional() })

opsRouter.put(
  '/faults/:group',
  asyncHandler(async (req, res) => {
    if (!GROUPS.some((g) => g.group === req.params.group)) throw new HttpError(422, 'UNKNOWN_GROUP', `Unknown consumer group ${req.params.group}`)
    await setFault(redis, req.params.group, faultSchema.parse(req.body))
    res.json({ faults: await listFaults(redis) })
  }),
)

opsRouter.delete(
  '/faults/:group',
  asyncHandler(async (req, res) => {
    await setFault(redis, req.params.group, null)
    res.json({ faults: await listFaults(redis) })
  }),
)

opsRouter.get('/catalog', (_req, res) => {
  res.json({
    events: Object.values(CATALOG).map((d) => ({ type: d.type, latest: d.latest, versions: Object.keys(d.schemas).map(Number), streamTypes: d.streamTypes, description: d.description })),
    groups: GROUPS,
  })
})

opsRouter.get(
  '/recent',
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Number(req.query.limit ?? 25))
    const { rows } = await pool.query<StoredEventRow>('SELECT * FROM events ORDER BY global_position DESC LIMIT $1', [limit])
    res.json({ events: rows.map((r) => eventDto(toEnvelope(r))) })
  }),
)
