/**
 * Live change notifications on this instance.
 *
 * One Valkey subscriber per API process receives every event published by any
 * instance. It (1) invalidates the in-memory catalog on `catalog` events and
 * (2) writes each event to the open SSE streams allowed to see it:
 *   user    → only that user's streams
 *   org     → only members of that org
 *   catalog → everyone
 * @module api/live
 */
import type { Response } from 'express'
import type { Redis } from 'ioredis'
import type { SessionUser } from '../shared/auth.js'
import { createRedisConnection, keys } from '../shared/cache.js'
import type { ChangeEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { eventsDelivered, sseConnections } from '../shared/metrics.js'
import { invalidateCatalog } from '../services/catalog.js'

export interface LiveClient {
  user: SessionUser
  clientId: string | null
  res: Response
}

const clients = new Set<LiveClient>()
let subscriber: Redis | null = null

export function canReceive(client: Pick<LiveClient, 'user'>, event: ChangeEvent): boolean {
  switch (event.type) {
    case 'user':
      return event.userId === client.user.id
    case 'org':
      return event.orgId === client.user.orgId
    case 'catalog':
      return true
  }
}

export function writeEvent(res: Response, name: string, data: unknown): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

export function dispatch(raw: string): void {
  let event: ChangeEvent
  try {
    event = JSON.parse(raw) as ChangeEvent
  } catch {
    return
  }
  if (event.type === 'catalog') invalidateCatalog(event.catalogRevision)
  for (const client of clients) {
    if (!canReceive(client, event)) continue
    writeEvent(client.res, event.type, event)
    eventsDelivered.inc({ type: event.type })
  }
}

export function startSubscriber(): void {
  if (subscriber) return
  subscriber = createRedisConnection('events-subscriber')
  subscriber.subscribe(keys.events).catch((err) => logger.error({ err: err.message }, 'subscribe failed'))
  subscriber.on('message', (_channel: string, raw: string) => dispatch(raw))
}

export function addClient(client: LiveClient): () => void {
  clients.add(client)
  sseConnections.inc()
  return () => {
    if (clients.delete(client)) sseConnections.dec()
  }
}

export function stopLive(): void {
  subscriber?.disconnect()
  subscriber = null
  for (const c of clients) c.res.end()
  clients.clear()
}
