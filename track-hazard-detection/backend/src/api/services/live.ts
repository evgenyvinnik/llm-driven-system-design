/**
 * Live-update hub: one Valkey subscriber per API instance, fanned out to the
 * SSE connections on this instance. Notices carry ids only; browsers refetch
 * through the access-checked read APIs, so no filtering of state is needed here.
 * @module api/services/live
 */
import type { Response } from 'express'
import type { SessionUser } from '../../shared/auth.js'
import { createRedisConnection } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { logger } from '../../shared/logger.js'
import { sseConnections } from '../../shared/metrics.js'

interface Client {
  user: SessionUser
  res: Response
}

const clients = new Set<Client>()
let subscriber: ReturnType<typeof createRedisConnection> | null = null
let counter = 0

function ensureSubscriber(): void {
  if (subscriber) return
  subscriber = createRedisConnection('api-live')
  void subscriber.subscribe(config.liveChannel)
  subscriber.on('message', (_channel, message) => {
    counter += 1
    for (const client of clients) client.res.write(`id: ${counter}\nevent: notice\ndata: ${message}\n\n`)
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
