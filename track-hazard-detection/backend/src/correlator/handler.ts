/**
 * The correlator's message handler. One transaction per edge event:
 *
 *   processed_events mark (idempotency) -> upcast + validate payload ->
 *   advisory locks on the segment and its neighbours within the radius ->
 *   lateness against the segment's watermark -> engine -> hazard events +
 *   outbox rows -> latency sample -> COMMIT -> (consumer) XACK
 *
 * Unknown sensors are a TransientError (the registry may simply not have
 * caught up with a field install): retried in place, then dead-lettered, and
 * redriven once ops registers the sensor.
 * @module correlator/handler
 */
import { config } from '../shared/config.js'
import { lockKey, withTransaction, type Client } from '../shared/db.js'
import { appendToStream, streamVersion, withConcurrencyRetry } from '../shared/event-store.js'
import { parseEdgePayload, isEdgeType, type EdgePayloads } from '../shared/events/edge.js'
import { draft } from '../shared/events/domain.js'
import { PermanentError, TransientError, type Envelope } from '../shared/events/envelope.js'
import type { HandlerOutcome } from '../shared/consumer.js'
import { markProcessed } from '../shared/idempotency.js'
import { decisionLatency, hazardTransitions } from '../shared/metrics.js'
import { segmentsNear, SEGMENT_BY_ID, SUBDIVISION_BY_ID } from '../shared/track.js'
import { correlateEvidence, onRailTemp, onTrainPosition, type Trigger } from './engine.js'
import { PgCorrelatorStore } from './pg-store.js'
import { evidenceFromEdge, defaultCorrelationConfig } from './rules.js'

export const CONSUMER = 'correlator'

interface SensorRow {
  id: string
  type: string
  subdivision_id: string
  segment_id: string
  milepost: number
  gateway_id: string
  neutral_temp_f: number | null
}

async function loadSensor(client: Client, id: string): Promise<SensorRow | null> {
  const { rows } = await client.query<SensorRow>('SELECT id, type, subdivision_id, segment_id, milepost, gateway_id, neutral_temp_f FROM sensors WHERE id = $1', [id])
  return rows[0] ?? null
}

async function lockSegments(client: Client, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey(`segment:${id}`)])
}

/** Late = occurred before the segment's (monotonic) watermark when the correlator processes it. */
async function isLate(client: Client, segmentId: string, occurredAt: string): Promise<boolean> {
  const { rows } = await client.query<{ late: boolean }>(
    `SELECT COALESCE($2::timestamptz < g.effective_watermark, false) AS late FROM gateway_state g JOIN segments s ON s.gateway_id = g.gateway_id WHERE s.id = $1`,
    [segmentId, occurredAt],
  )
  return rows[0]?.late ?? false
}

async function appendCoverage(client: Client, streamId: string, partitionKey: string, d: ReturnType<typeof draft>, env: Envelope): Promise<Envelope[]> {
  const version = await streamVersion(client, streamId)
  return appendToStream(client, streamId, version, [d], { partitionKey, source: CONSUMER, correlationId: env.correlationId, causationId: env.eventId, meta: { actor: CONSUMER } })
}

/** Any report from a sensor proves it is alive: restore its coverage if it was degraded. */
async function sensorSeen(client: Client, sensor: SensorRow, env: Envelope, value: unknown): Promise<Envelope[]> {
  const { rows } = await client.query<{ coverage: string }>(
    `INSERT INTO sensor_state (sensor_id, last_seen_at, last_value) VALUES ($1, $2, $3)
     ON CONFLICT (sensor_id) DO UPDATE SET last_seen_at = GREATEST(sensor_state.last_seen_at, EXCLUDED.last_seen_at),
       last_value = CASE WHEN sensor_state.last_seen_at IS NULL OR EXCLUDED.last_seen_at >= sensor_state.last_seen_at THEN EXCLUDED.last_value ELSE sensor_state.last_value END
     RETURNING coverage`,
    [sensor.id, env.occurredAt, JSON.stringify(value)],
  )
  if (rows[0]?.coverage !== 'degraded') return []
  await client.query(`UPDATE sensor_state SET coverage = 'ok', degraded_since = NULL WHERE sensor_id = $1`, [sensor.id])
  return appendCoverage(client, `sensor-${sensor.id}`, sensor.segment_id, draft('CoverageRestored', { scope: 'sensor', targetId: sensor.id, subdivisionId: sensor.subdivision_id, segmentId: sensor.segment_id, restoredAt: env.occurredAt }), env)
}

async function heartbeatMissed(client: Client, sensor: SensorRow, env: Envelope, p: EdgePayloads['SensorHeartbeatMissed']): Promise<Envelope[]> {
  const { rows } = await client.query<{ coverage: string; last_seen_at: Date | null }>('SELECT coverage, last_seen_at FROM sensor_state WHERE sensor_id = $1', [sensor.id])
  const state = rows[0]
  // A late "missed" report for a sensor that has reported since is stale.
  if (state?.coverage === 'degraded' || (state?.last_seen_at && new Date(state.last_seen_at).toISOString() > env.occurredAt)) return []
  await client.query(
    `INSERT INTO sensor_state (sensor_id, coverage, degraded_since) VALUES ($1, 'degraded', $2)
     ON CONFLICT (sensor_id) DO UPDATE SET coverage = 'degraded', degraded_since = EXCLUDED.degraded_since`,
    [sensor.id, p.lastSeenAt],
  )
  const seg = SEGMENT_BY_ID.get(sensor.segment_id)
  const mp = Number(sensor.milepost)
  return appendCoverage(
    client,
    `sensor-${sensor.id}`,
    sensor.segment_id,
    draft('CoverageDegraded', {
      scope: 'sensor',
      targetId: sensor.id,
      subdivisionId: sensor.subdivision_id,
      segmentId: sensor.segment_id,
      mpFrom: Math.max(seg?.startMp ?? mp - 1, mp - 1),
      mpTo: Math.min(seg?.endMp ?? mp + 1, mp + 1),
      reason: 'heartbeat_missed',
      since: p.lastSeenAt,
    }),
    env,
  )
}

async function recordDecision(client: Client, env: Envelope, lane: string, late: boolean): Promise<void> {
  const totalMs = Date.now() - Date.parse(env.occurredAt)
  decisionLatency.observe({ lane, late: String(late) }, totalMs / 1000)
  // Every critical-lane decision is sampled; bulk readings 1 in 10 (they are most of the volume).
  if (lane !== 'critical' && Number.parseInt(env.eventId.slice(-2), 16) % 10 !== 0) return
  await client.query(
    `INSERT INTO latency_samples (kind, event_id, event_type, lane, late, edge_occurred_at, ingested_at, detected_at, total_ms)
     VALUES ('decision', $1, $2, $3, $4, $5, $6, clock_timestamp(), $7)`,
    [env.eventId, env.type, lane, late, env.occurredAt, env.recordedAt, totalMs],
  )
}

export interface HandleResult {
  outcome: HandlerOutcome
  appended: Envelope[]
}

export async function handleEdgeEvent(env: Envelope): Promise<HandleResult> {
  const cfg = defaultCorrelationConfig()
  return withConcurrencyRetry(() =>
    withTransaction(async (client) => {
      if (!(await markProcessed(client, CONSUMER, env.eventId))) return { outcome: 'duplicate' as const, appended: [] }
      if (!isEdgeType(env.type)) throw new PermanentError('UNKNOWN_TYPE', `Unknown edge event type ${env.type}`)
      const lane = String(env.meta.lane ?? 'bulk')
      const appended: Envelope[] = []

      if (env.type === 'TrainPositionReported') {
        const p = parseEdgePayload('TrainPositionReported', env.version, env.payload)
        if (!SUBDIVISION_BY_ID.has(p.subdivisionId)) throw new PermanentError('UNKNOWN_SUBDIVISION', `Unknown subdivision ${p.subdivisionId}`)
        await lockSegments(client, segmentsNear(p.subdivisionId, p.milepost, 1.5).map((s) => s.id))
        const store = new PgCorrelatorStore(client)
        const trigger: Trigger = { eventId: env.eventId, occurredAt: env.occurredAt, recordedAt: env.recordedAt, lane, late: Boolean(env.meta.late), correlationId: env.correlationId }
        await onTrainPosition(store, { trainId: p.trainId, symbol: p.symbol, milepost: p.milepost, direction: p.direction, speedMph: p.speedMph, occurredAt: env.occurredAt }, p.subdivisionId, trigger, cfg)
        appended.push(...store.appended)
        return { outcome: 'ok' as const, appended }
      }

      const payload = parseEdgePayload(env.type, env.version, env.payload) as EdgePayloads[Exclude<typeof env.type, 'TrainPositionReported'>]
      const sensor = await loadSensor(client, payload.sensorId)
      if (!sensor) throw new TransientError('UNKNOWN_SENSOR', `Sensor ${payload.sensorId} is not in the registry`)
      const mp = Number(sensor.milepost)
      await lockSegments(client, segmentsNear(sensor.subdivision_id, mp, cfg.radiusMiles).map((s) => s.id))
      const late = await isLate(client, sensor.segment_id, env.occurredAt)
      const trigger: Trigger = { eventId: env.eventId, occurredAt: env.occurredAt, recordedAt: env.recordedAt, lane, late, correlationId: env.correlationId }
      const store = new PgCorrelatorStore(client)

      if (env.type === 'SensorHeartbeatMissed') {
        appended.push(...(await heartbeatMissed(client, sensor, env, payload as EdgePayloads['SensorHeartbeatMissed'])))
      } else {
        appended.push(...(await sensorSeen(client, sensor, env, payload)))
        const reading = payload as EdgePayloads['SensorReadingReported']
        if (env.type === 'SensorReadingReported' && reading.kind === 'rail_temp' && typeof reading.tempF === 'number') {
          const seg = SEGMENT_BY_ID.get(sensor.segment_id)!
          await onRailTemp(
            store,
            {
              sensorId: sensor.id,
              subdivisionId: sensor.subdivision_id,
              segmentId: sensor.segment_id,
              segmentStartMp: seg.startMp,
              segmentEndMp: seg.endMp,
              neutralTempF: Number(sensor.neutral_temp_f ?? 95),
              sample: { occurredAt: env.occurredAt, tempF: reading.tempF },
            },
            trigger,
            config.heat,
          )
        } else {
          const facts = evidenceFromEdge({ type: env.type, payload: payload as unknown as Record<string, unknown> }, cfg)
          if (facts) {
            await correlateEvidence(
              store,
              {
                eventId: env.eventId,
                kind: facts.kind,
                sensorId: sensor.id,
                subdivisionId: sensor.subdivision_id,
                segmentId: sensor.segment_id,
                milepost: mp,
                occurredAt: env.occurredAt,
                confidence: facts.confidence,
                late,
                explainedByTrain: null,
                hazardId: null,
                details: facts.details,
              },
              trigger,
              cfg,
            )
          }
        }
      }
      appended.push(...store.appended)
      await recordDecision(client, env, lane, late)
      return { outcome: 'ok' as const, appended }
    }),
  ).then((result) => {
    for (const e of result.appended) hazardTransitions.inc({ type: e.type, late: String(Boolean((e.payload as { late?: boolean }).late)) })
    return result
  })
}
