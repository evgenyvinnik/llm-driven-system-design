/**
 * SDK streams open on this API instance. When the snapshot service learns of
 * a newer snapshot (from this instance's own write, a pub/sub message from
 * another instance, or the reconcile loop), every stream of that environment
 * gets a `snapshot` event naming the new version. The event is a hint: the
 * client fetches that exact, immutable version.
 * @module api/live
 */
import type { Response } from 'express'
import { pushesSent, streamConnections } from '../shared/metrics.js'
import { onSnapshot } from '../services/snapshot-service.js'

export interface StreamClient {
  environment: string
  sdkInstanceId: string
  label: string
  res: Response
}

const clients = new Set<StreamClient>()

export function writeEvent(res: Response, name: string, data: unknown): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

let unsubscribe: (() => void) | null = null

export function startLive(): void {
  if (unsubscribe) return
  unsubscribe = onSnapshot((snap, notice) => {
    for (const client of clients) {
      if (client.environment !== snap.environment) continue
      writeEvent(client.res, 'snapshot', { version: snap.version, etag: snap.etag, reason: notice.reason, publishedAt: notice.publishedAt })
      pushesSent.inc()
    }
  })
}

export function addStreamClient(client: StreamClient): () => void {
  clients.add(client)
  streamConnections.inc()
  return () => {
    if (clients.delete(client)) streamConnections.dec()
  }
}

export function streamCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of clients) out[c.environment] = (out[c.environment] ?? 0) + 1
  return out
}

export function stopLive(): void {
  unsubscribe?.()
  unsubscribe = null
  for (const c of clients) c.res.end()
  clients.clear()
}
