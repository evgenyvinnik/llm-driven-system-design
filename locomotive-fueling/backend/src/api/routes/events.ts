/**
 * Live updates over Server-Sent Events. One Valkey subscriber per API
 * process fans out to every open stream on that process. Each event is
 * checked against the viewer before it is written: crew only receive events
 * about their own train. Events are invalidations ("train T03 changed"), and
 * the browser refetches through the normal, access-checked endpoints.
 * @module api/routes/events
 */
import { Router, type Response } from 'express'
import type { Redis } from 'ioredis'
import { canSeeTrain, requireAuth, type SessionUser } from '../../shared/auth.js'
import { createRedisConnection, keys } from '../../shared/cache.js'
import type { LiveEvent } from '../../shared/events.js'
import { logger } from '../../shared/logger.js'
import { sseConnections } from '../../shared/metrics.js'

export const eventsRouter = Router()

const clients = new Set<{ user: SessionUser; res: Response }>()
let subscriber: Redis | null = null

function ensureSubscriber(): void {
  if (subscriber) return
  subscriber = createRedisConnection('sse-subscriber')
  void subscriber.subscribe(keys.events)
  subscriber.on('message', (_channel, raw) => {
    let event: LiveEvent
    try {
      event = JSON.parse(raw) as LiveEvent
    } catch {
      return
    }
    for (const client of clients) {
      if (event.trainId && !canSeeTrain(client.user, event.trainId)) continue
      if (!event.trainId && client.user.role === 'crew' && event.type !== 'price') continue
      client.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
  })
}

export function closeSubscriber(): void {
  subscriber?.disconnect()
  subscriber = null
  for (const c of clients) c.res.end()
  clients.clear()
}

eventsRouter.get('/', requireAuth, (req, res) => {
  ensureSubscriber()
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  res.write(`retry: 3000\nevent: hello\ndata: {}\n\n`)
  const client = { user: req.user!, res }
  clients.add(client)
  sseConnections.inc()
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    clients.delete(client)
    sseConnections.dec()
  })
  logger.debug({ user: req.user!.username }, 'sse connected')
})
