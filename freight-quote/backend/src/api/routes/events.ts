import { Router } from 'express'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { requireRole } from '../../shared/auth.js'
import { rowToEnvelope } from '../../shared/event-store.js'
import { parseEvent, LATEST_VERSION, isEventType } from '../../shared/events.js'
import { streamHealth } from '../../shared/monitor.js'

/** The event log (ops). Each row also shows the payload as consumers see it after upcasting. */
export function eventsRouter(redis: Redis): Router {
  const router = Router()
  router.use(requireRole('ops'))

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          type: z.string().optional(),
          stream: z.string().optional(),
          correlation: z.string().optional(),
          before: z.coerce.number().int().optional(),
          /** Only events stored at an older schema version than consumers read (they get upcast). */
          old: z.enum(['1']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query)
      const params: unknown[] = [q.limit]
      const where: string[] = []
      if (q.type) where.push(`type = $${params.push(q.type)}`)
      if (q.stream) where.push(`stream_id = $${params.push(q.stream)}`)
      if (q.correlation) where.push(`correlation_id = $${params.push(q.correlation)}`)
      if (q.before) where.push(`position < $${params.push(q.before)}`)
      if (q.old) {
        const versioned = Object.entries(LATEST_VERSION).filter(([, v]) => v > 1)
        where.push(`(${versioned.map(([t, v]) => `(type = '${t}' AND version < ${v})`).join(' OR ') || 'false'})`)
      }
      const { rows } = await pool.query(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY position DESC LIMIT $1`, params)
      const events = rows.map((r) => {
        const env = rowToEnvelope(r)
        let upcast: Record<string, unknown> | null = null
        if (isEventType(env.type) && env.version < LATEST_VERSION[env.type]) {
          try {
            upcast = parseEvent(env).payload as Record<string, unknown>
          } catch {
            upcast = null
          }
        }
        return { ...env, latestVersion: isEventType(env.type) ? LATEST_VERSION[env.type] : null, upcastPayload: upcast }
      })
      const counts = await pool.query<{ type: string; n: number }>('SELECT type, COUNT(*)::int AS n FROM events GROUP BY type ORDER BY type')
      res.json({ events, counts: counts.rows })
    }),
  )

  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      res.json(await streamHealth(redis, pool))
    }),
  )

  return router
}
