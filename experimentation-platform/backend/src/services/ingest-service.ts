/**
 * The ingest endpoint's work: validate, correct skew, then atomically mark the
 * batch id as seen and append the batch to the Valkey stream (one Lua script,
 * so there is no window where a batch is marked seen but not enqueued).
 *
 * A retried batch (the SDK lost the response and re-sent the same batchId)
 * hits the seen key and is acknowledged without being enqueued again.
 * @module services/ingest-service
 */
import { prepareBatch, type BatchEnvelope } from '../ingest/batch.js'
import { keys, redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { ingestEvents } from '../shared/metrics.js'

const ENQUEUE_ONCE = `
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then
  return redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', 'b', ARGV[3])
end
return false`

export interface IngestResult {
  accepted: number
  rejected: { index: number; reason: string }[]
  duplicate: boolean
  streamId: string | null
}

export async function ingestBatch(environment: string, envelope: BatchEnvelope, receivedAt = Date.now()): Promise<IngestResult> {
  const { batch, rejected } = prepareBatch(envelope, environment, receivedAt, {
    maxEventAgeMs: config.ingest.maxEventAgeDays * 86_400_000,
    maxFutureMs: config.ingest.maxFutureSkewMs,
  })
  if (rejected.length > 0) ingestEvents.inc({ type: 'invalid', outcome: 'rejected' }, rejected.length)
  if (batch.events.length === 0) return { accepted: 0, rejected, duplicate: false, streamId: null }
  const streamId = (await redis.eval(
    ENQUEUE_ONCE,
    2,
    keys.batchSeen(environment, envelope.batchId),
    keys.eventStream,
    String(config.ingest.batchDedupTtlSeconds),
    String(config.ingest.streamMaxLen),
    JSON.stringify(batch),
  )) as string | null
  const outcome = streamId ? 'accepted' : 'duplicate_batch'
  for (const e of batch.events) ingestEvents.inc({ type: e.event.type, outcome })
  return { accepted: streamId ? batch.events.length : 0, rejected, duplicate: !streamId, streamId }
}
