/**
 * Reads per-request event logs (Valkey streams) for every request this gateway
 * instance is waiting on, with ONE blocking connection: a single
 * `XREAD BLOCK ... STREAMS k1 k2 ... id1 id2 ...` covers all of them.
 *
 * Because the log is in Valkey rather than in this process, the gateway that
 * accepted a request need not be the one that streams it: any instance can
 * attach by request id and replay from any event id (Last-Event-ID).
 * A new subscription interrupts the current block with CLIENT UNBLOCK.
 * @module gateway/stream-hub
 */
import type { Redis } from 'ioredis'
import { createRedisConnection, keys, redis } from '../shared/cache.js'
import { logger } from '../shared/logger.js'
import type { RequestEventType } from '../shared/requests.js'

export interface HubEvent {
  /** Valkey stream entry id, used as the SSE event id. */
  eventId: string
  type: RequestEventType
  data: Record<string, unknown>
}

type Listener = (ev: HubEvent) => void

interface Sub {
  requestId: string
  lastId: string
  listener: Listener
}

export class StreamHub {
  private subs = new Map<number, Sub>()
  private nextSub = 1
  private conn: Redis | null = null
  private connId: number | null = null
  private running = false
  private wake: (() => void) | null = null

  start(): void {
    if (this.running) return
    this.running = true
    this.conn = createRedisConnection('stream-hub')
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.wake?.()
    this.conn?.disconnect()
  }

  /** Delivers every event after `fromId` ('0' = from the beginning). Returns an unsubscribe function. */
  subscribe(requestId: string, listener: Listener, fromId = '0'): () => void {
    const id = this.nextSub++
    this.subs.set(id, { requestId, lastId: fromId, listener })
    if (this.wake) this.wake()
    else if (this.connId !== null) void redis.client('UNBLOCK', this.connId).catch(() => undefined)
    return () => {
      this.subs.delete(id)
    }
  }

  get size(): number {
    return this.subs.size
  }

  private async loop(): Promise<void> {
    const conn = this.conn as Redis
    try {
      this.connId = Number(await conn.client('ID'))
    } catch {
      this.connId = null
    }
    while (this.running) {
      if (this.subs.size === 0) {
        await new Promise<void>((resolve) => (this.wake = resolve))
        this.wake = null
        continue
      }
      // One cursor per stream: the smallest last id of its subscribers.
      const cursor = new Map<string, string>()
      for (const s of this.subs.values()) {
        const prev = cursor.get(s.requestId)
        if (prev === undefined || compareIds(s.lastId, prev) < 0) cursor.set(s.requestId, s.lastId)
      }
      const ids = [...cursor.keys()]
      try {
        const res = (await conn.xread('COUNT', 500, 'BLOCK', 1000, 'STREAMS', ...ids.map((i) => keys.events(i)), ...ids.map((i) => cursor.get(i) as string))) as
          | [string, [string, string[]][]][]
          | null
        if (!res) continue
        for (const [streamKey, entries] of res) {
          const requestId = streamKey.slice(keys.events('').length)
          for (const [eventId, fields] of entries) {
            const ev = parseEntry(eventId, fields)
            for (const s of this.subs.values()) {
              if (s.requestId !== requestId || compareIds(eventId, s.lastId) <= 0) continue
              s.lastId = eventId
              try {
                s.listener(ev)
              } catch (err) {
                logger.warn({ err }, 'stream listener failed')
              }
            }
          }
        }
      } catch (err) {
        if (!this.running) return
        const msg = err instanceof Error ? err.message : String(err)
        // CLIENT UNBLOCK makes XREAD return an UNBLOCKED error (or null); just loop.
        if (!msg.includes('UNBLOCKED')) {
          logger.warn({ err: msg }, 'stream hub read failed')
          await new Promise((r) => setTimeout(r, 200))
        }
      }
    }
  }
}

function parseEntry(eventId: string, fields: string[]): HubEvent {
  const map: Record<string, string> = {}
  for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1]
  let data: Record<string, unknown>
  try {
    data = JSON.parse(map.d ?? '{}') as Record<string, unknown>
  } catch {
    data = {}
  }
  return { eventId, type: map.e as RequestEventType, data }
}

/** Compares Valkey stream ids ("ms-seq"); '0' sorts first. */
export function compareIds(a: string, b: string): number {
  const [am, as = '0'] = a.split('-')
  const [bm, bs = '0'] = b.split('-')
  const d = Number(am) - Number(bm)
  return d !== 0 ? d : Number(as) - Number(bs)
}

export const hub = new StreamHub()
