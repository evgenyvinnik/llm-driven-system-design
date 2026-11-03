/**
 * Producing generated traffic to Kafka. Shared by the generator CLI and the seed.
 * @module generator/produce
 */
import type { Producer } from 'kafkajs'
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import type { ChatEvent } from '../shared/contract.js'
import { pool } from '../shared/db.js'
import { DAY, MINUTE } from '../shared/time.js'
import { ORGS } from './profiles.js'
import { defaultIncidents, generateMinute, type TrafficOptions } from './traffic.js'

export const CURSOR_KEY = 'generator:cursor'

export async function trafficOptions(now: number): Promise<TrafficOptions> {
  const { rows } = await pool.query<{ collected_from: Date }>(
    "SELECT collected_from FROM metric_coverage WHERE metric = 'abandon_rate'",
  )
  const abandonTrackedFrom = rows[0] ? rows[0].collected_from.getTime() : now - 14 * DAY
  return { abandonTrackedFrom, incidents: defaultIncidents(now), anchor: now }
}

export function toMessage(event: Omit<ChatEvent, 'received_time'>, receivedAt: number) {
  const full: ChatEvent = { ...event, received_time: new Date(receivedAt).toISOString() } as ChatEvent
  return { key: event.org_id, value: JSON.stringify(full) }
}

export async function sendAll(producer: Producer, messages: { key: string; value: string }[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 5000) {
    await producer.send({ topic: config.kafka.topic, messages: messages.slice(i, i + 5000) })
  }
}

/**
 * On-time history for [from, to): received_time is event_time plus network
 * delay. Messages are produced in received_time order, like a real collector:
 * a conversation that starts at 00:59 has replies at 01:20, so each hour's
 * events that are received after the hour carry over into the next batch.
 */
export async function produceHistory(producer: Producer, from: number, to: number, opts: TrafficOptions): Promise<number> {
  let total = 0
  let carry: { at: number; event: Omit<ChatEvent, 'received_time'> }[] = []
  for (let hour = Math.floor(from / MINUTE) * MINUTE; hour < to; hour += 60 * MINUTE) {
    const hourEnd = Math.min(hour + 60 * MINUTE, to)
    const pending = carry
    for (let m = hour; m < hourEnd; m += MINUTE) {
      for (const org of ORGS) {
        for (const g of generateMinute(org, m, opts)) {
          const at = Date.parse(g.event.event_time) + g.deliveryDelayMs
          if (at < to) pending.push({ at, event: g.event })
        }
      }
    }
    pending.sort((a, b) => a.at - b.at)
    const cut = pending.findIndex((p) => p.at >= hourEnd)
    const now = cut === -1 ? pending : pending.slice(0, cut)
    carry = cut === -1 ? [] : pending.slice(cut)
    await sendAll(producer, now.map((p) => toMessage(p.event, p.at)))
    total += now.length
  }
  await redis.set(CURSOR_KEY, String(Math.floor(to / MINUTE) * MINUTE))
  return total
}

