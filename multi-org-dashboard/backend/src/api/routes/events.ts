/**
 * GET /api/v1/events: the tab's single event stream. It survives org
 * switches (events carry their orgId and the client routes them), so
 * switching orgs never reconnects.
 */
import { Router } from 'express'
import { requireAuth } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { openSse, writeSse } from '../../shared/sse.js'
import { eventHub } from '../services/event-hub.js'

export const eventsRouter = Router()

eventsRouter.get(
  '/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { rows } = await pool.query(
      `SELECT o.id, o.authz_version FROM org_memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1`,
      [user.id],
    )
    openSse(res)
    res.write('retry: 3000\n\n')
    const conn = eventHub.add(
      user.id,
      req.sessionId!,
      rows.map((r) => r.id),
      res,
    )
    // On every (re)connect the client learns the current versions and refetches any manifest that is behind.
    writeSse(res, 'hello', {
      type: 'hello',
      orgs: rows.map((r) => ({ orgId: r.id, version: Number(r.authz_version) })),
    })
    const heartbeat = eventHub.startHeartbeat(conn)
    req.on('close', () => {
      clearInterval(heartbeat)
      eventHub.remove(conn)
    })
  }),
)
