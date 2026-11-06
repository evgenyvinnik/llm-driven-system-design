/**
 * Read models for the operator dashboard: the strip-map board, the alert
 * queue, speed restrictions, the latency budget and the event log.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { asyncHandler } from '../../shared/errors.js'
import { alerts, board, eventLog, latency, restrictions } from '../services/queries.js'

export const readRouter = Router()
readRouter.use(requireAuth)

readRouter.get('/board', asyncHandler(async (_req, res) => res.json(await board())))

readRouter.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    const scope = z.enum(['mine', 'all']).catch('mine').parse(req.query.scope)
    res.json(await alerts(req.user!, scope, req.query.closed === 'true'))
  }),
)

readRouter.get(
  '/restrictions',
  asyncHandler(async (req, res) => {
    const status = z.enum(['active', 'all']).catch('active').parse(req.query.status)
    res.json({ restrictions: await restrictions(status) })
  }),
)

readRouter.get('/latency', asyncHandler(async (_req, res) => res.json(await latency())))

readRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        type: z.string().max(64).optional(),
        streamId: z.string().max(80).optional(),
        correlationId: z.string().max(80).optional(),
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(500).catch(100),
      })
      .parse(req.query)
    res.json(await eventLog({ ...q, limit: q.limit ?? 100 }))
  }),
)
