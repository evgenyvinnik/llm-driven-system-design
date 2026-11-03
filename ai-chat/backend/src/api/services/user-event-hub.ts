/**
 * Device sync: one Valkey subscriber connection per API instance, subscribed
 * only to the channels of users who have a device connected to this
 * instance (reference-counted), and fanning each message out to those
 * devices' SSE responses.
 *
 * Pub/sub is fire-and-forget, so this is a fast path only. The client
 * re-reads its conversation list and active generations whenever this stream
 * (re)connects, which covers anything published while it was away.
 */
import type { Request, Response } from 'express'
import type { Redis } from 'ioredis'
import { sessionStillValid } from '../../shared/auth.js'
import { createRedisConnection } from '../../shared/cache.js'
import { logger } from '../../shared/logger.js'
import { sseConnections } from '../../shared/metrics.js'
import { openSse, writeSse, writeSseComment } from '../../shared/sse.js'
import { userEventsChannel } from '../../shared/user-events.js'

type Listener = (raw: string) => void

class UserEventHub {
  private subscriber: Redis | null = null
  private listeners = new Map<string, Set<Listener>>()

  private connection(): Redis {
    if (!this.subscriber) {
      this.subscriber = createRedisConnection('user-events-subscriber')
      this.subscriber.on('message', (channel: string, raw: string) => {
        for (const listener of this.listeners.get(channel) ?? []) listener(raw)
      })
    }
    return this.subscriber
  }

  async add(userId: string, listener: Listener): Promise<() => Promise<void>> {
    const channel = userEventsChannel(userId)
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
      await this.connection().subscribe(channel)
    }
    set.add(listener)
    return async () => {
      const current = this.listeners.get(channel)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.listeners.delete(channel)
        await this.connection()
          .unsubscribe(channel)
          .catch(() => undefined)
      }
    }
  }
}

export const userEventHub = new UserEventHub()

const PING_MS = 15_000

export async function streamUserEvents(req: Request, res: Response): Promise<void> {
  const user = req.user!
  openSse(res)
  sseConnections.inc({ kind: 'device' })
  // Tells the client the subscription is live, so it can reconcile from REST right after.
  writeSse(res, 'ready', { at: new Date().toISOString() })
  const remove = await userEventHub.add(user.id, (raw) => {
    try {
      const event = JSON.parse(raw) as { type: string }
      writeSse(res, event.type, event)
    } catch (err) {
      logger.warn({ err }, 'bad user event payload')
    }
  })
  const ping = setInterval(() => {
    void (async () => {
      if (!(await sessionStillValid(req.sessionId).catch(() => true))) {
        res.end()
        return
      }
      writeSseComment(res, 'ping')
    })()
  }, PING_MS)
  req.on('close', () => {
    clearInterval(ping)
    sseConnections.dec({ kind: 'device' })
    void remove()
  })
}
