/**
 * Live updates over Server-Sent Events. One-way push is all the dashboard
 * needs; the browser refetches on each notice and on reconnect, so a missed
 * notice costs a refresh, never correctness.
 */
import { Router } from 'express'
import { requireAuth } from '../../shared/auth.js'
import { addClient } from '../services/live.js'

export const liveRouter = Router()

liveRouter.get('/', requireAuth, (req, res) => {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  res.write('retry: 3000\n\n')
  res.write(`event: hello\ndata: ${JSON.stringify({ role: req.user!.role })}\n\n`)
  const remove = addClient(req.user!, res)
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    remove()
  })
})
