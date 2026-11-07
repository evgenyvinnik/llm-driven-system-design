/**
 * Per-run event log in a Valkey stream. The executing API instance appends;
 * any instance can serve `GET /answers/:id/stream` by replaying the stream
 * from the client's Last-Event-ID, so a reconnect (even to the other API
 * instance) resumes exactly where it left off. Cancel requests travel on a
 * pub/sub channel every instance listens to.
 * @module api/services/run-events
 */
import type { Redis } from 'ioredis'
import { config } from '../../shared/config.js'
import { createRedisConnection, keys, redis } from '../../shared/cache.js'

export type RunEventType = 'status' | 'cache' | 'retrieval' | 'delta' | 'completed' | 'failed' | 'cancelled'
export const TERMINAL: RunEventType[] = ['completed', 'failed', 'cancelled']

export interface RunEvent {
  id: string
  type: RunEventType
  data: Record<string, unknown>
}

export async function appendEvent(runId: string, type: RunEventType, data: Record<string, unknown>): Promise<string | null> {
  const key = keys.runEvents(runId)
  const id = await redis.xadd(key, '*', 'type', type, 'data', JSON.stringify(data))
  if (TERMINAL.includes(type)) await redis.expire(key, config.answers.streamTtlSeconds)
  else await redis.expire(key, config.answers.streamTtlSeconds * 2)
  return id
}

function parseEntries(entries: [string, string[]][]): RunEvent[] {
  return entries.map(([id, fields]) => {
    const map: Record<string, string> = {}
    for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]] = fields[i + 1]
    return { id, type: map.type as RunEventType, data: JSON.parse(map.data ?? '{}') as Record<string, unknown> }
  })
}

/**
 * Yields events after `fromId` until a terminal event, the abort signal, or
 * `idleMs` without anything new. Uses its own blocking connection.
 */
export async function* readEvents(runId: string, fromId: string, signal: AbortSignal, idleMs = 60_000): AsyncGenerator<RunEvent> {
  const conn: Redis = createRedisConnection(`run-stream-${runId}`)
  const onAbort = () => conn.disconnect()
  signal.addEventListener('abort', onAbort)
  let cursor = fromId
  let idleSince = Date.now()
  try {
    while (!signal.aborted) {
      const res = (await conn.xread('COUNT', 200, 'BLOCK', 2000, 'STREAMS', keys.runEvents(runId), cursor).catch(() => null)) as [string, [string, string[]][]][] | null
      if (signal.aborted) return
      if (!res) {
        if (Date.now() - idleSince > idleMs) return
        continue
      }
      idleSince = Date.now()
      for (const ev of parseEntries(res[0][1])) {
        cursor = ev.id
        yield ev
        if (TERMINAL.includes(ev.type)) return
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    conn.disconnect()
  }
}

type CancelListener = (runId: string) => void
let subscriber: Redis | null = null
const listeners = new Set<CancelListener>()

export function onCancel(listener: CancelListener): () => void {
  if (!subscriber) {
    subscriber = createRedisConnection('cancel-sub')
    void subscriber.subscribe(keys.cancelChannel)
    subscriber.on('message', (_channel: string, runId: string) => {
      for (const l of listeners) l(runId)
    })
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function publishCancel(runId: string): Promise<void> {
  await redis.publish(keys.cancelChannel, runId)
}
