/**
 * Stream consumer with two lanes. The live lane (fresh passes) is always
 * drained first; the backfill lane (passes that sat in a gateway buffer) is
 * taken a couple of messages at a time between live checks, so a site
 * reconnecting with hours of backlog cannot delay a new critical reading.
 *
 * A message is acked only after processPass has committed. A consumer that dies
 * between commit and ack leaves it pending; another consumer claims it after
 * claimIdleMs and processPass sees the pass already processed. A message that
 * keeps failing is dead-lettered.
 * @module analyzer/consumer
 */
import type { Redis } from 'ioredis'
import { config } from '../shared/config.js'
import { publishEvents } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { alertTransitions, passesProcessed, processSeconds, streamRedeliveries } from '../shared/metrics.js'
import { ensureGroup, fieldsToObject, laneKey, type Lane } from '../shared/stream.js'
import { tierName } from './risk.js'
import { processPass } from './pipeline.js'

type StreamEntry = [id: string, fields: string[]]
const LANES: Lane[] = ['live', 'backfill']

export async function handleEntry(client: Redis, lane: Lane, id: string, fields: string[]): Promise<void> {
  const { detectorId, passId } = fieldsToObject(fields)
  const end = processSeconds.startTimer({ lane })
  try {
    const result = await processPass(detectorId, passId)
    passesProcessed.inc({ outcome: result.outcome, lane })
    for (const t of result.transitions) alertTransitions.inc({ transition: t.transition, tier: tierName(t.tier), late: String(t.late) })
    await client.xack(laneKey(lane), config.stream.group, id)
    await publishEvents(result.events)
    if (result.outcome !== 'processed' || result.transitions.length > 0 || result.corrections > 0 || result.excludedPreInstall > 0) {
      logger.info({ lane, detectorId, passId, outcome: result.outcome, transitions: result.transitions, corrections: result.corrections, excludedPreInstall: result.excludedPreInstall }, 'pass handled')
    }
  } catch (err) {
    passesProcessed.inc({ outcome: 'failed', lane })
    logger.error({ err, lane, detectorId, passId, id }, 'pass processing failed; left pending for retry')
  } finally {
    end()
  }
}

/** Claims messages a stalled consumer left pending; dead-letters ones delivered too many times. */
async function reclaim(client: Redis, lane: Lane): Promise<void> {
  const key = laneKey(lane)
  const pending = (await client.xpending(key, config.stream.group, 'IDLE', config.stream.claimIdleMs, '-', '+', 50)) as Array<[string, string, number, number]>
  for (const [id, , , deliveries] of pending) {
    if (deliveries >= config.stream.maxDeliveries) {
      const entries = (await client.xrange(key, id, id)) as StreamEntry[]
      if (entries[0]) await client.xadd(config.stream.deadLetterKey, '*', ...entries[0][1], 'originalId', id, 'lane', lane)
      await client.xack(key, config.stream.group, id)
      streamRedeliveries.inc({ kind: 'dead_lettered' })
      logger.error({ id, lane, deliveries }, 'pass message dead-lettered')
    }
  }
  const claimed = (await client.xautoclaim(key, config.stream.group, config.stream.consumer, config.stream.claimIdleMs, '0', 'COUNT', 20)) as [string, StreamEntry[]]
  for (const [id, fields] of claimed[1] ?? []) {
    if (!fields) continue
    streamRedeliveries.inc({ kind: 'claimed' })
    await handleEntry(client, lane, id, fields)
  }
}

async function read(client: Redis, lane: Lane, count: number, cursor: '0' | '>'): Promise<StreamEntry[]> {
  const res = (await client.xreadgroup('GROUP', config.stream.group, config.stream.consumer, 'COUNT', count, 'STREAMS', laneKey(lane), cursor)) as
    | Array<[string, StreamEntry[]]>
    | null
  return res?.[0]?.[1] ?? []
}

export async function runConsumer(client: Redis, shouldStop: () => boolean): Promise<void> {
  await ensureGroup(client)
  // First drain anything this consumer name already owns (a restart after a crash).
  for (const lane of LANES) for (const [id, fields] of await read(client, lane, 1000, '0')) if (fields) await handleEntry(client, lane, id, fields)
  let lastReclaim = 0
  while (!shouldStop()) {
    try {
      if (Date.now() - lastReclaim > config.stream.claimIdleMs / 2) {
        lastReclaim = Date.now()
        for (const lane of LANES) await reclaim(client, lane)
      }
      const live = await read(client, 'live', 50, '>')
      for (const [id, fields] of live) await handleEntry(client, 'live', id, fields)
      if (live.length > 0) continue
      // Live lane empty: take a small bite of backfill, then look at live again.
      const backfill = await read(client, 'backfill', config.stream.backfillBatch, '>')
      for (const [id, fields] of backfill) await handleEntry(client, 'backfill', id, fields)
      if (backfill.length > 0) continue
      // Both empty: block until either lane has something.
      const res = (await client.xreadgroup(
        'GROUP', config.stream.group, config.stream.consumer, 'COUNT', 1, 'BLOCK', 2000,
        'STREAMS', config.stream.liveKey, config.stream.backfillKey, '>', '>',
      )) as Array<[string, StreamEntry[]]> | null
      for (const [key, entries] of res ?? []) {
        const lane: Lane = key === config.stream.liveKey ? 'live' : 'backfill'
        for (const [id, fields] of entries) await handleEntry(client, lane, id, fields)
      }
    } catch (err) {
      if (shouldStop()) break
      const message = (err as Error).message
      // The streams were deleted (e.g. by a reseed): recreate the groups and carry on.
      if (message.includes('NOGROUP')) await ensureGroup(client).catch(() => undefined)
      logger.error({ err: message }, 'consumer loop error')
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
