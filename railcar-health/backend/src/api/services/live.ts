/**
 * Live-update hub: one Valkey subscriber per API instance, fanned out to the
 * SSE connections on this instance. Each notice is filtered by the viewer's
 * role before it is written: a yard inspector only hears about their own yard.
 * @module api/services/live
 */
import type { Response } from 'express'
import type { SessionUser } from '../../shared/auth.js'
import { createRedisConnection } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import type { LiveEvent } from '../../shared/events.js'
import { logger } from '../../shared/logger.js'
import { sseConnections } from '../../shared/metrics.js'

interface Client {
  user: SessionUser
  res: Response
}

const clients = new Set<Client>()
let subscriber: ReturnType<typeof createRedisConnection> | null = null
let counter = 0

export function canSee(user: SessionUser, event: LiveEvent): boolean {
  if (user.role !== 'yard') return true
  if (event.type.startsWith('alert.') || event.type === 'workorder.updated') return event.yardId === user.yardId
  return true
}

function ensureSubscriber(): void {
  if (subscriber) return
  subscriber = createRedisConnection('api-live')
  void subscriber.subscribe(config.eventsChannel)
  subscriber.on('message', (_channel, message) => {
    let event: LiveEvent
    try {
      event = JSON.parse(message) as LiveEvent
    } catch {
      return
    }
    counter += 1
    for (const client of clients) {
      if (!canSee(client.user, event)) continue
      client.res.write(`id: ${counter}\nevent: ${event.type}\ndata: ${message}\n\n`)
    }
  })
}

export function addClient(user: SessionUser, res: Response): () => void {
  ensureSubscriber()
  const client = { user, res }
  clients.add(client)
  sseConnections.set(clients.size)
  return () => {
    clients.delete(client)
    sseConnections.set(clients.size)
  }
}

export async function closeLive(): Promise<void> {
  for (const c of clients) c.res.end()
  clients.clear()
  if (subscriber) {
    subscriber.disconnect()
    subscriber = null
  }
  logger.debug('live hub closed')
}
