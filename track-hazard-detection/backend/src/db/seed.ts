/**
 * Seeds reference data, users and a few days of closed hazard history.
 * Rerunnable: it wipes PostgreSQL and the Valkey streams, then reseeds.
 *
 * History is appended to the event store as complete hazard lifecycles (with
 * recorded times in the past) and the projections are then *built by replay*,
 * exactly as `npm run replay` would. History events get no outbox rows: they
 * were "published" long ago, so the process manager and notifier never react
 * to them. All of it is illustrative demo data.
 */
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { redis } from '../shared/cache.js'
import { pool, withTransaction, type Client } from '../shared/db.js'
import type { DomainType } from '../shared/events/domain.js'
import { DESKS, SEGMENTS, SENSORS, SUBDIVISIONS } from '../shared/track.js'
import { PROJECTIONS } from '../projector/projections.js'
import { rebuildProjection } from '../projector/store.js'

const USERS = [
  { username: 'alice', name: 'Alice Moreno', role: 'dispatcher', desk: 'WEST' },
  { username: 'dan', name: 'Dan Okafor', role: 'dispatcher', desk: 'EAST' },
  { username: 'bob', name: 'Bob Lindqvist', role: 'inspector', desk: null },
  { username: 'erin', name: 'Erin Walsh', role: 'inspector', desk: null },
  { username: 'carol', name: 'Carol Nguyen', role: 'admin', desk: null },
] as const

const MIN = 60_000
const now = Date.now()

async function reset(client: Client): Promise<void> {
  await client.query(`TRUNCATE events, outbox, edge_events, gateway_state, train_positions, processed_events, command_log, evidence, correlation_hazards,
    rail_temp_samples, heat_state, sensor_state, timers, notifications, latency_samples, proj_hazards, proj_alerts, proj_restrictions, proj_coverage,
    projection_versions, projection_checkpoints, train_view, users, sensors, segments, subdivisions, desks RESTART IDENTITY CASCADE`)
  await client.query(`ALTER SEQUENCE hazard_code_seq RESTART WITH 1001`)
}

async function wipeStreams(): Promise<void> {
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'th:*', 'COUNT', 500)
    if (keys.length) await redis.del(...keys)
    cursor = next
  } while (cursor !== '0')
}

async function seedReference(client: Client): Promise<void> {
  for (const d of DESKS) await client.query('INSERT INTO desks (id, name) VALUES ($1, $2)', [d.id, d.name])
  for (const s of SUBDIVISIONS) await client.query('INSERT INTO subdivisions (id, name, start_mp, end_mp, desk_id) VALUES ($1, $2, $3, $4, $5)', [s.id, s.name, s.startMp, s.endMp, s.deskId])
  for (const s of SEGMENTS) {
    await client.query('INSERT INTO segments (id, subdivision_id, start_mp, end_mp, gateway_id) VALUES ($1, $2, $3, $4, $5)', [s.id, s.subdivisionId, s.startMp, s.endMp, s.gatewayId])
    await client.query('INSERT INTO gateway_state (gateway_id, segment_id) VALUES ($1, $2)', [s.gatewayId, s.id])
  }
  for (const s of SENSORS) {
    await client.query('INSERT INTO sensors (id, type, subdivision_id, segment_id, milepost, gateway_id, neutral_temp_f, label) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      s.id, s.type, s.subdivisionId, s.segmentId, s.milepost, s.gatewayId, s.neutralTempF ?? null, s.label ?? null,
    ])
    await client.query('INSERT INTO sensor_state (sensor_id) VALUES ($1)', [s.id])
  }
  const hash = await bcrypt.hash('password123', 10)
  for (const u of USERS) await client.query('INSERT INTO users (username, display_name, password_hash, role, desk_id) VALUES ($1, $2, $3, $4, $5)', [u.username, u.name, hash, u.role, u.desk])
}

interface Step {
  type: DomainType
  atMin: number
  source: string
  actor: string
  payload: Record<string, unknown>
}

/** Writes one historical hazard lifecycle straight into the event store. */
async function history(client: Client, startMinAgo: number, segmentId: string, build: (h: { hazardId: string; code: string; t0: number; iso: (m: number) => string }) => Step[]): Promise<void> {
  const hazardId = randomUUID()
  const { rows } = await client.query<{ n: number }>(`SELECT nextval('hazard_code_seq') AS n`)
  const code = `HZ-${rows[0].n}`
  const t0 = now - startMinAgo * MIN
  const iso = (m: number) => new Date(t0 + m * MIN).toISOString()
  const steps = build({ hazardId, code, t0, iso })
  const correlationId = randomUUID()
  let causation: string | null = null
  for (const [i, s] of steps.entries()) {
    const eventId = randomUUID()
    const occurred = new Date(t0 + s.atMin * MIN)
    const recorded = new Date(occurred.getTime() + 400 + i * 30)
    await client.query(
      `INSERT INTO events (event_id, stream_id, stream_version, type, version, partition_key, occurred_at, recorded_at, correlation_id, causation_id, source, meta, payload)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [eventId, `hazard-${hazardId}`, i + 1, s.type, segmentId, occurred, recorded, correlationId, causation, s.source, { actor: s.actor, seed: true, lane: 'domain' }, { hazardId, ...s.payload }],
    )
    causation = eventId
  }
}

const trig = (iso: string) => ({ eventId: randomUUID(), occurredAt: iso, recordedAt: iso, lane: 'critical', late: false })
const ev = (sensorId: string, kind: string, milepost: number, occurredAt: string, confidence: number) => ({ eventId: randomUUID(), sensorId, kind, milepost, occurredAt, confidence, late: false })

async function seedHistory(client: Client): Promise<void> {
  // A rockfall in the Canyon three days ago: fence break plus geophone, CRITICAL, inspected and cleared.
  await history(client, 3 * 24 * 60 + 200, 'CAN-4', ({ code, iso }) => [
    { type: 'HazardDetected', atMin: 0, source: 'correlator', actor: 'correlator', payload: { code, kind: 'rockfall', subdivisionId: 'CAN', segmentId: 'CAN-4', mpFrom: 134.8, mpTo: 135.9, confidence: 0.92, severity: 'CRITICAL', detectionStatus: 'confirmed', evidence: [ev('FNC-134.8', 'fence_break', 134.8, iso(0), 0.85), ev('GEO-135.9', 'ground_vibration', 135.9, iso(0), 0.46)], late: false, trigger: trig(iso(0)) } },
    { type: 'AlertIssued', atMin: 0.02, source: 'alerting', actor: 'alerting', payload: { alertId: `AL-${code.slice(3)}`, severity: 'CRITICAL', deskId: 'WEST', assignee: 'alice', ackDeadlineAt: iso(1), summary: 'Rockfall MP 134.8-135.9 (CAN, confidence 0.92)', lane: 'critical', late: false, timing: { edgeOccurredAt: iso(0), ingestedAt: iso(0), detectedAt: iso(0.01) } } },
    { type: 'TrainsWarned', atMin: 0.03, source: 'alerting', actor: 'alerting', payload: { trains: [{ trainId: 'C-BTMNAT9-01', symbol: 'C-BTMNAT9', etaMinutes: 14.5, distanceMiles: 7.3, direction: 'decreasing' }], instruction: 'Stop short of MP 136.4; Rockfall MP 134.8-135.9', automatic: true, by: 'alerting' } },
    { type: 'AlertAcknowledged', atMin: 0.6, source: 'api', actor: 'alice', payload: { alertId: `AL-${code.slice(3)}`, by: 'alice' } },
    { type: 'SpeedRestrictionIssued', atMin: 1.5, source: 'api', actor: 'alice', payload: { restrictionId: 'SR-HIST0001', subdivisionId: 'CAN', mpFrom: 134.3, mpTo: 136.4, maxSpeedMph: 10, reason: `${code} rockfall`, automatic: false, by: 'alice' } },
    { type: 'InspectorDispatched', atMin: 2, source: 'api', actor: 'alice', payload: { inspector: 'bob', inspectorName: 'Bob Lindqvist', etaMinutes: 35, by: 'alice', note: 'Hi-rail from Cutbank' } },
    { type: 'HazardCleared', atMin: 52, source: 'api', actor: 'bob', payload: { by: 'bob', note: 'Two rocks removed from the gauge; fence panel re-strung.' } },
    { type: 'SpeedRestrictionLifted', atMin: 52.05, source: 'alerting', actor: 'alerting', payload: { restrictionId: 'SR-HIST0001', reason: 'hazard cleared', by: 'alerting' } },
    { type: 'TrainsReleased', atMin: 52.06, source: 'alerting', actor: 'alerting', payload: { trainIds: ['C-BTMNAT9-01'], reason: 'hazard cleared', by: 'alerting' } },
  ])
  // A crossing camera false alarm on the Prairie two days ago.
  await history(client, 2 * 24 * 60 + 90, 'PRA-2', ({ code, iso }) => [
    { type: 'HazardDetected', atMin: 0, source: 'correlator', actor: 'correlator', payload: { code, kind: 'obstruction', subdivisionId: 'PRA', segmentId: 'PRA-2', mpFrom: 199.8, mpTo: 199.8, confidence: 0.61, severity: 'HIGH', detectionStatus: 'detected', evidence: [ev('CAM-199.8', 'camera_obstruction', 199.8, iso(0), 0.61)], late: false, trigger: trig(iso(0)) } },
    { type: 'AlertIssued', atMin: 0.02, source: 'alerting', actor: 'alerting', payload: { alertId: `AL-${code.slice(3)}`, severity: 'HIGH', deskId: 'EAST', assignee: 'dan', ackDeadlineAt: iso(3), summary: 'Obstruction on track MP 199.8 (PRA, confidence 0.61)', lane: 'critical', late: false, timing: { edgeOccurredAt: iso(0), ingestedAt: iso(0), detectedAt: iso(0.01) } } },
    { type: 'AlertAcknowledged', atMin: 1.1, source: 'api', actor: 'dan', payload: { alertId: `AL-${code.slice(3)}`, by: 'dan' } },
    { type: 'HazardConfirmedFalseAlarm', atMin: 4, source: 'api', actor: 'dan', payload: { by: 'dan', note: 'Crossing camera frame shows a truck shadow; the crossing gate camera confirms clear.', cause: 'shadow' } },
  ])
  // A heat-risk afternoon yesterday: standing heat order issued and lifted automatically.
  await history(client, 24 * 60 + 300, 'PRA-4', ({ code, iso }) => [
    { type: 'HazardRiskElevated', atMin: 0, source: 'correlator', actor: 'correlator', payload: { code, kind: 'rail_buckling_risk', subdivisionId: 'PRA', segmentId: 'PRA-4', mpFrom: 210, mpTo: 220, band: 'elevated', severity: 'MEDIUM', sensorId: 'RTS-215.0', railTempF: 128, neutralTempF: 96, projectedTempF: 133.5, slopeFPerMin: 0.55, trigger: trig(iso(0)) } },
    { type: 'AlertIssued', atMin: 0.02, source: 'alerting', actor: 'alerting', payload: { alertId: `AL-${code.slice(3)}`, severity: 'MEDIUM', deskId: 'EAST', assignee: 'dan', ackDeadlineAt: iso(10), summary: 'Rail buckling risk (heat) MP 210.0-220.0 (PRA, rail 128°F (RNT 96°F))', lane: 'bulk', late: false, timing: { edgeOccurredAt: iso(0), ingestedAt: iso(0), detectedAt: iso(0.01) } } },
    { type: 'SpeedRestrictionIssued', atMin: 0.03, source: 'alerting', actor: 'alerting', payload: { restrictionId: 'SR-HIST0002', subdivisionId: 'PRA', mpFrom: 210, mpTo: 220, maxSpeedMph: 40, reason: 'Heat: rail 128°F, projected 133.5°F vs RNT 96°F (elevated)', automatic: true, by: 'alerting' } },
    { type: 'AlertAcknowledged', atMin: 3, source: 'api', actor: 'dan', payload: { alertId: `AL-${code.slice(3)}`, by: 'dan' } },
    { type: 'HazardRiskSubsided', atMin: 185, source: 'correlator', actor: 'correlator', payload: { railTempF: 118, projectedTempF: 118 } },
    { type: 'SpeedRestrictionLifted', atMin: 185.02, source: 'alerting', actor: 'alerting', payload: { restrictionId: 'SR-HIST0002', reason: 'rail temperature back below the watch band', by: 'alerting' } },
    { type: 'HazardCleared', atMin: 185.03, source: 'alerting', actor: 'alerting', payload: { by: 'alerting', note: 'Rail temperature back below the watch band; standing heat order lifted.' } },
  ])
  // High water at a Canyon bridge last week.
  await history(client, 6 * 24 * 60 + 500, 'CAN-3', ({ code, iso }) => [
    { type: 'HazardDetected', atMin: 0, source: 'correlator', actor: 'correlator', payload: { code, kind: 'high_water', subdivisionId: 'CAN', segmentId: 'CAN-3', mpFrom: 124.6, mpTo: 124.6, confidence: 0.6, severity: 'HIGH', detectionStatus: 'detected', evidence: [ev('WTR-124.6', 'high_water', 124.6, iso(0), 0.6)], late: false, trigger: trig(iso(0)) } },
    { type: 'AlertIssued', atMin: 0.02, source: 'alerting', actor: 'alerting', payload: { alertId: `AL-${code.slice(3)}`, severity: 'HIGH', deskId: 'WEST', assignee: 'alice', ackDeadlineAt: iso(3), summary: 'High water MP 124.6 (CAN, confidence 0.60)', lane: 'critical', late: false, timing: { edgeOccurredAt: iso(0), ingestedAt: iso(0), detectedAt: iso(0.01) } } },
    { type: 'AlertEscalated', atMin: 3, source: 'alerting', actor: 'alerting', payload: { alertId: `AL-${code.slice(3)}`, level: 1, reason: 'ack_overdue', target: 'chief dispatcher', severity: 'HIGH', ackDeadlineAt: iso(6) } },
    { type: 'AlertAcknowledged', atMin: 3.4, source: 'api', actor: 'alice', payload: { alertId: `AL-${code.slice(3)}`, by: 'alice' } },
    { type: 'SpeedRestrictionIssued', atMin: 4, source: 'api', actor: 'alice', payload: { restrictionId: 'SR-HIST0003', subdivisionId: 'CAN', mpFrom: 124, mpTo: 125.2, maxSpeedMph: 10, reason: `${code} high water`, automatic: false, by: 'alice' } },
    { type: 'InspectorDispatched', atMin: 5, source: 'api', actor: 'alice', payload: { inspector: 'erin', inspectorName: 'Erin Walsh', etaMinutes: 50, by: 'alice' } },
    { type: 'HazardCleared', atMin: 140, source: 'api', actor: 'erin', payload: { by: 'erin', note: 'Water 30 in below base of rail and falling; ballast shoulder intact.' } },
    { type: 'SpeedRestrictionLifted', atMin: 140.05, source: 'alerting', actor: 'alerting', payload: { restrictionId: 'SR-HIST0003', reason: 'hazard cleared', by: 'alerting' } },
  ])
}

async function main(): Promise<void> {
  await wipeStreams()
  await withTransaction(async (client) => {
    await reset(client)
    await seedReference(client)
    await seedHistory(client)
  })
  for (const p of PROJECTIONS) {
    const r = await rebuildProjection(p)
    console.log(`projection ${p.name}: ${r.after.rows} rows from ${r.eventsReplayed} events`)
  }
  console.log(`Seeded ${SENSORS.length} sensors on ${SEGMENTS.length} segments, ${USERS.length} users (password: password123)`)
}

try {
  await main()
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
  redis.disconnect()
}
