/**
 * Stream consumer. Reads the pass stream as a member of a consumer group and
 * acks a message only after processPass has committed. A consumer that dies
 * between commit and ack leaves the message pending; another consumer claims it
 * after it has been idle for claimIdleMs, and processPass sees the pass already
 * processed and skips it. A message that keeps failing is dead-lettered.
 * @module analyzer/consumer
 */
import type { Redis } from 'ioredis'
import { config } from '../shared/config.js'
import { publishEvents } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { alertTransitions, passesProcessed, processSeconds, streamRedeliveries } from '../shared/metrics.js'
import { ensureGroup, fieldsToObject } from '../shared/stream.js'
import { tierName } from './risk.js'
import { processPass } from './pipeline.js'

type StreamEntry = [id: string, fields: string[]]

export async function handleEntry(client: Redis, id: string, fields: string[]): Promise<void> {
  const { detectorId, passId } = fieldsToObject(fields)
  const end = processSeconds.startTimer()
  try {
    const result = await processPass(detectorId, passId)
    passesProcessed.inc({ outcome: result.outcome })
    for (const t of result.transitions) alertTransitions.inc({ transition: t.transition, tier: tierName(t.tier), late: String(t.late) })
    await client.xack(config.stream.key, config.stream.group, id)
    await publishEvents(result.events)
    if (result.outcome !== 'processed' || result.transitions.length > 0 || result.corrections > 0) {
      logger.info({ detectorId, passId, outcome: result.outcome, transitions: result.transitions, corrections: result.corrections }, 'pass handled')
    }
  } catch (err) {
    passesProcessed.inc({ outcome: 'failed' })
    logger.error({ err, detectorId, passId, id }, 'pass processing failed; left pending for retry')
  } finally {
    end()
  }
}

/** Claims messages a stalled consumer left pending; dead-letters ones delivered too many times. */
async function reclaim(client: Redis): Promise<void> {
  const pending = (await client.xpending(config.stream.key, config.stream.group, 'IDLE', config.stream.claimIdleMs, '-', '+', 50)) as Array<
    [string, string, number, number]
  >
  for (const [id, , , deliveries] of pending) {
    if (deliveries >= config.stream.maxDeliveries) {
      const entries = (await client.xrange(config.stream.key, id, id)) as StreamEntry[]
      if (entries[0]) await client.xadd(config.stream.deadLetterKey, '*', ...entries[0][1], 'originalId', id)
      await client.xack(config.stream.key, config.stream.group, id)
      streamRedeliveries.inc({ kind: 'dead_lettered' })
      logger.error({ id, deliveries }, 'pass message dead-lettered')
    }
  }
  const claimed = (await client.xautoclaim(config.stream.key, config.stream.group, config.stream.consumer, config.stream.claimIdleMs, '0', 'COUNT', 20)) as [
    string,
    StreamEntry[],
  ]
  for (const [id, fields] of claimed[1] ?? []) {
    if (!fields) continue
    streamRedeliveries.inc({ kind: 'claimed' })
    await handleEntry(client, id, fields)
  }
}

export async function runConsumer(client: Redis, shouldStop: () => boolean): Promise<void> {
  await ensureGroup(client)
  // First drain anything this consumer name already owns (a restart after a crash).
  let backlog = true
  let lastReclaim = 0
  while (!shouldStop()) {
    try {
      if (Date.now() - lastReclaim > config.stream.claimIdleMs / 2) {
        lastReclaim = Date.now()
        await reclaim(client)
      }
      const res = (await client.xreadgroup(
        'GROUP', config.stream.group, config.stream.consumer,
        'COUNT', 20, 'BLOCK', 2000,
        'STREAMS', config.stream.key, backlog ? '0' : '>',
      )) as Array<[string, StreamEntry[]]> | null
      const entries = res?.[0]?.[1] ?? []
      if (backlog && entries.length === 0) backlog = false
      for (const [id, fields] of entries) await handleEntry(client, id, fields)
    } catch (err) {
      if (shouldStop()) break
      const message = (err as Error).message
      // The stream was deleted (e.g. by a reseed): recreate the group and carry on.
      if (message.includes('NOGROUP')) await ensureGroup(client).catch(() => undefined)
      logger.error({ err: message }, 'consumer loop error')
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
