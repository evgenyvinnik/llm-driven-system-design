/**
 * Traffic generator CLI. It plays the role of the collector: it stamps
 * received_time and produces events to Kafka keyed by org_id.
 *
 *   live              stream events in real time, with duplicates and late arrivals
 *   history --days N  produce N days of on-time history (used by db:seed)
 *   late  [--org id] [--count n] [--hours-ago h]
 *                     events that happened yesterday afternoon (org-local), arriving now
 *   dupes [--org id] [--count n]
 *                     re-send events that were already ingested, same event_id
 */
import { DateTime } from 'luxon'
import type { Producer } from 'kafkajs'
import { redis } from '../shared/cache.js'
import { chQuery, clickhouse } from '../shared/clickhouse.js'
import { config } from '../shared/config.js'
import type { ChatEvent } from '../shared/contract.js'
import { pool } from '../shared/db.js'
import { ensureTopic, kafka } from '../shared/kafka.js'
import { childLogger } from '../shared/logger.js'
import { DAY, MINUTE } from '../shared/time.js'
import { ORGS } from './profiles.js'
import { CURSOR_KEY, produceHistory, sendAll, toMessage, trafficOptions } from './produce.js'
import { deterministicUuid, generateMinute, type GeneratedEvent } from './traffic.js'

const log = childLogger('generator')

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

async function live(producer: Producer): Promise<void> {
  const opts = await trafficOptions(Date.now())
  const queue: { at: number; event: GeneratedEvent['event'] }[] = []
  const recent: GeneratedEvent['event'][] = []
  let sent = 0
  let duplicates = 0
  let late = 0

  // Resume where the seed or the previous run stopped, so a restart leaves no hole (capped at a day).
  const stored = Number(await redis.get(CURSOR_KEY))
  const nowMinute = Math.floor(Date.now() / MINUTE) * MINUTE
  let cursor = stored > 0 ? Math.max(stored, nowMinute - DAY) : nowMinute
  if (cursor < nowMinute) {
    const n = await produceHistory(producer, cursor, nowMinute, opts)
    log.info({ events: n, minutes: (nowMinute - cursor) / MINUTE }, 'filled the gap since the last run')
    cursor = nowMinute
  }

  const planMinute = (minute: number) => {
    for (const org of ORGS) {
      for (const g of generateMinute(org, minute, opts)) {
        const happened = Date.parse(g.event.event_time)
        let deliverAt = happened + g.deliveryDelayMs
        // A phone that was offline delivers its client events in a burst later.
        if (g.event.source === 'client' && Math.random() < config.lateRate) {
          deliverAt = happened + (11 + Math.random() * 80) * MINUTE
          late++
        }
        queue.push({ at: deliverAt, event: g.event })
      }
    }
    queue.sort((a, b) => a.at - b.at)
  }

  planMinute(cursor)
  setInterval(async () => {
    const now = Date.now()
    while (cursor + MINUTE <= now) {
      cursor += MINUTE
      planMinute(cursor)
      await redis.set(CURSOR_KEY, String(cursor))
    }
    const due: { key: string; value: string }[] = []
    while (queue.length && queue[0].at <= now) {
      const { event } = queue.shift()!
      due.push(toMessage(event, now))
      recent.push(event)
      if (recent.length > 500) recent.shift()
    }
    // A client that retries after a lost acknowledgement sends the same event_id again.
    for (let i = 0; i < due.length; i++) {
      if (Math.random() < config.duplicateRate && recent.length > 0) {
        due.push(toMessage(recent[Math.floor(Math.random() * recent.length)], now))
        duplicates++
      }
    }
    if (due.length) {
      await producer.send({ topic: config.kafka.topic, messages: due }).catch((err) => log.warn({ err: err.message }, 'send failed'))
      sent += due.length
    }
  }, 1000)

  setInterval(() => log.info({ sent, duplicates, late, queued: queue.length }, 'live traffic'), 30_000)
}

async function orgOrDefault(): Promise<{ id: string; timeZone: string }> {
  const id = arg('org', 'larkspur')!
  const org = ORGS.find((o) => o.id === id)
  if (!org) throw new Error(`unknown org ${id}`)
  return org
}

/** Conversations that happened yesterday afternoon in the org's zone, delivered now. */
async function lateBurst(producer: Producer): Promise<void> {
  const org = await orgOrDefault()
  const count = Number(arg('count', '200'))
  const hoursAgo = arg('hours-ago')
  const now = Date.now()
  const base = hoursAgo
    ? now - Number(hoursAgo) * 3_600_000
    : DateTime.fromMillis(now, { zone: org.timeZone }).minus({ days: 1 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 }).toMillis()
  const run = Date.now().toString(36)
  const messages = []
  for (let i = 0; i < count; i++) {
    const at = base + Math.floor((i / count) * 3_600_000)
    const event = {
      event_id: deterministicUuid(`late:${run}:${i}`),
      schema_version: 1 as const,
      event_type: 'conversation_started' as const,
      source: 'client' as const,
      org_id: org.id,
      user_id: `u_late${String(i % 40).padStart(8, '0')}`,
      conversation_id: `c_late_${run}_${i}`,
      model: 'orion-swift',
      feature: 'chat' as const,
      platform: 'ios' as const,
      event_time: new Date(at).toISOString(),
    }
    messages.push(toMessage(event, now))
  }
  await sendAll(producer, messages)
  const day = DateTime.fromMillis(base, { zone: org.timeZone }).toISODate()
  log.info({ org: org.id, count, localDate: day }, 'sent late conversation_started events')
  console.log(`Sent ${count} late conversation_started events for ${org.id}, local date ${day}.`)
}

/** Re-sends already-ingested events with their original event_id and payload. */
async function duplicates(producer: Producer): Promise<void> {
  const org = await orgOrDefault()
  const count = Number(arg('count', '300'))
  const rows = await chQuery<Record<string, string | number>>(
    `SELECT toString(event_id) AS event_id, event_type, source, org_id, user_id, conversation_id, generation_id,
            toUnixTimestamp64Milli(event_time) AS event_ms, model, feature, platform,
            ttft_ms, latency_ms, input_tokens, output_tokens, error_code, abandon_reason
       FROM events
      WHERE org_id = {org:String} AND event_type = 'conversation_started'
        AND local_date = {day:Date}
      ORDER BY event_id
      LIMIT {count:UInt32}`,
    { org: org.id, count, day: DateTime.now().setZone(org.timeZone).minus({ days: 1 }).toISODate() },
  )
  const now = Date.now()
  const messages = rows.map((r) => {
    const event: Record<string, unknown> = {
      event_id: r.event_id,
      schema_version: 1,
      event_type: r.event_type,
      source: r.source,
      org_id: r.org_id,
      user_id: r.user_id,
      conversation_id: r.conversation_id,
      event_time: new Date(Number(r.event_ms)).toISOString(),
      model: r.model,
      feature: r.feature,
    }
    if (r.platform) event.platform = r.platform
    return toMessage(event as Omit<ChatEvent, 'received_time'>, now)
  })
  await sendAll(producer, messages)
  console.log(`Re-sent ${messages.length} already-ingested conversation_started events for ${org.id} (same event_ids).`)
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'live'
  await ensureTopic()
  const producer = kafka.producer({ allowAutoTopicCreation: false })
  await producer.connect()

  if (mode === 'live') {
    await live(producer)
    const stop = async () => {
      await producer.disconnect().catch(() => undefined)
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  }

  try {
    if (mode === 'history') {
      const days = Number(arg('days', '35'))
      const to = Math.floor(Date.now() / MINUTE) * MINUTE
      const n = await produceHistory(producer, to - days * DAY, to, await trafficOptions(to))
      console.log(`Produced ${n} events covering ${days} days.`)
    } else if (mode === 'late') {
      await lateBurst(producer)
    } else if (mode === 'dupes') {
      await duplicates(producer)
    } else {
      throw new Error(`unknown mode ${mode}`)
    }
  } finally {
    await producer.disconnect()
    await Promise.allSettled([pool.end(), redis.quit(), clickhouse.close()])
  }
}

main().catch((err) => {
  log.error({ err }, 'generator failed')
  process.exit(1)
})

