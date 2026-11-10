/**
 * GET /api/v1/events: the SSE stream. The first event, `hello`, carries the
 * current revisions read at connect time, so a client that reconnects after
 * missing events sees the difference and refetches. After that the stream
 * carries `user`, `org` and `catalog` events from any instance (api/live).
 * @module api/routes/events
 */
import { Router } from 'express'
import { requireAuth } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { asyncHandler } from '../../shared/errors.js'
import { getRevisions } from '../../services/settings-service.js'
import { clientIdentity } from '../http.js'
import { addClient, writeEvent } from '../live.js'

export const eventsRouter = Router()

eventsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    res.write('retry: 2000\n\n')
    // Register before reading revisions: an event committed in between is then
    // delivered (possibly ahead of hello) instead of falling into a gap.
    const remove = addClient({ user, clientId: clientIdentity(req).clientId, res })
    const heartbeat = setInterval(() => res.write(': ping\n\n'), config.sseHeartbeatMs)
    req.on('close', () => {
      clearInterval(heartbeat)
      remove()
    })
    const revisions = await getRevisions(user)
    writeEvent(res, 'hello', { instanceId: config.instanceId, ...revisions })
  }),
)
