/**
 * The hold feed as a broker stream: a Valkey stream standing in for the `cases`
 * Kafka topic in railcar-health/events.md. At-least-once: an entry is acked only
 * after its transaction commits, so a crash redelivers it, and `applyHoldEvent`
 * makes that harmless. Entries that can't be parsed go to a dead-letter stream
 * instead of wedging the group.
 * @module holds/stream
 */
import type { Redis } from 'ioredis'
import { keys } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { withTransaction } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { applyHoldEvent, type HoldEnvelope } from './apply.js'

export async function publishHoldEvent(redis: Redis, event: HoldEnvelope): Promise<void> {
  await redis.xadd(keys.holdStream, 'MAXLEN', '~', '10000', '*', 'event', JSON.stringify(event))
}

export function startHoldConsumer(blocking: Redis, consumer: string): { stop: () => void } {
  let running = true
  const group = config.holds.group
  const stream = keys.holdStream
  const ensureGroup = async () => {
    try {
      await blocking.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err
    }
  }
  const handle = async (id: string, fields: string[]) => {
    const raw = fields[fields.indexOf('event') + 1]
    try {
      await withTransaction((client) => applyHoldEvent(client, JSON.parse(raw), 'stream'))
      await blocking.xack(stream, group, id)
    } catch (err) {
      logger.error({ err, id }, 'hold event failed; dead-lettering it')
      await blocking.xadd(`${stream}:dlq`, '*', 'event', raw, 'error', String(err))
      await blocking.xack(stream, group, id)
    }
  }
  const loop = async () => {
    await ensureGroup()
    // Anything delivered to this consumer before a crash comes first.
    let cursor = '0'
    while (running) {
      try {
        const reply = (await blocking.xreadgroup('GROUP', group, consumer, 'COUNT', 50, 'BLOCK', 1000, 'STREAMS', stream, cursor)) as [string, [string, string[]][]][] | null
        const entries = reply?.[0]?.[1] ?? []
        for (const [id, fields] of entries) await handle(id, fields)
        if (cursor === '0' && entries.length === 0) cursor = '>'
      } catch (err) {
        if (!running) return
        if (err instanceof Error && err.message.includes('NOGROUP')) await ensureGroup()
        else logger.warn({ err }, 'hold consumer read failed')
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
  void loop()
  return {
    stop: () => {
      running = false
    },
  }
}
