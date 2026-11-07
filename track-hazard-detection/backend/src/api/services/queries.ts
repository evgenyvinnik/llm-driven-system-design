/**
 * Read side. Everything here reads projections or the event store; nothing
 * folds state on the request path except the hazard timeline, which is the
 * stream itself.
 * @module api/services/queries
 */
import type { SessionUser } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { rowToEnvelope } from '../../shared/event-store.js'
import { notFound } from '../../shared/errors.js'
import type { HazardState } from '../../shared/hazard.js'
import { SEGMENTS, SUBDIVISIONS } from '../../shared/track.js'
import { approachingTrains } from '../../alerting/reconcile.js'

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null)

export async function trains() {
  const { rows } = await pool.query(
    `SELECT train_id, symbol, subdivision_id, milepost, direction, speed_mph, occurred_at FROM train_view WHERE occurred_at > now() - interval '15 minutes' ORDER BY subdivision_id, milepost`,
  )
  return rows.map((r) => ({ trainId: r.train_id, symbol: r.symbol, subdivisionId: r.subdivision_id, milepost: Number(r.milepost), direction: r.direction, speedMph: Number(r.speed_mph), occurredAt: iso(r.occurred_at)! }))
}

export async function board() {
  const [sensors, hazards, restrictions, coverage, gateways, trainList, kpi] = await Promise.all([
    pool.query(
      `SELECT s.id, s.type, s.subdivision_id, s.segment_id, s.milepost, s.label, s.neutral_temp_f, ss.coverage, ss.last_seen_at, ss.last_value
       FROM sensors s LEFT JOIN sensor_state ss ON ss.sensor_id = s.id ORDER BY s.milepost`,
    ),
    pool.query(`SELECT doc FROM proj_hazards WHERE open OR (doc->>'closedAt')::timestamptz > now() - interval '10 minutes'`),
    pool.query(`SELECT doc FROM proj_restrictions WHERE active ORDER BY doc->>'issuedAt'`),
    pool.query(`SELECT doc FROM proj_coverage WHERE status = 'degraded'`),
    pool.query(
      `SELECT gateway_id, segment_id, last_seen_at, reported_watermark, effective_watermark, buffered_count, coverage, batches, events_accepted, duplicates,
              EXTRACT(EPOCH FROM (now() - effective_watermark))::float AS watermark_lag_s
       FROM gateway_state ORDER BY gateway_id`,
    ),
    trains(),
    pool.query(
      `SELECT
         (SELECT count(*) FROM proj_hazards WHERE open AND severity = 'CRITICAL')::int AS open_critical,
         (SELECT count(*) FROM proj_hazards WHERE open)::int AS open_hazards,
         (SELECT count(*) FROM proj_alerts WHERE status = 'open')::int AS unacked,
         (SELECT count(*) FROM proj_restrictions WHERE active)::int AS active_restrictions,
         (SELECT percentile_cont(0.99) WITHIN GROUP (ORDER BY total_ms) FROM latency_samples WHERE kind = 'alert' AND NOT late) AS alert_p99_ms,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) FROM latency_samples WHERE kind = 'alert' AND NOT late) AS alert_p50_ms`,
    ),
  ])
  const degradedSegments = new Set([...coverage.rows.map((r) => r.doc.segmentId as string)])
  return {
    subdivisions: SUBDIVISIONS,
    segments: SEGMENTS.map((s) => {
      const g = gateways.rows.find((r) => r.gateway_id === s.gatewayId)
      return { ...s, degraded: degradedSegments.has(s.id), gatewayCoverage: g?.coverage ?? 'ok', watermarkLagSeconds: g?.watermark_lag_s ?? null, lastSeenAt: iso(g?.last_seen_at) }
    }),
    sensors: sensors.rows.map((r) => ({
      id: r.id,
      type: r.type,
      subdivisionId: r.subdivision_id,
      segmentId: r.segment_id,
      milepost: Number(r.milepost),
      label: r.label,
      neutralTempF: r.neutral_temp_f === null ? null : Number(r.neutral_temp_f),
      coverage: r.coverage ?? 'ok',
      lastSeenAt: iso(r.last_seen_at),
      lastValue: r.last_value ?? null,
    })),
    hazards: hazards.rows.map((r) => r.doc as HazardState),
    restrictions: restrictions.rows.map((r) => r.doc),
    coverage: coverage.rows.map((r) => r.doc),
    trains: trainList,
    kpis: {
      openCritical: kpi.rows[0].open_critical,
      openHazards: kpi.rows[0].open_hazards,
      unacknowledged: kpi.rows[0].unacked,
      activeRestrictions: kpi.rows[0].active_restrictions,
      degradedSegments: degradedSegments.size,
      alertP50Ms: kpi.rows[0].alert_p50_ms === null ? null : Math.round(Number(kpi.rows[0].alert_p50_ms)),
      alertP99Ms: kpi.rows[0].alert_p99_ms === null ? null : Math.round(Number(kpi.rows[0].alert_p99_ms)),
    },
    serverTime: new Date().toISOString(),
  }
}

export async function hazards(status: 'open' | 'closed' | 'all') {
  const where = status === 'open' ? 'WHERE open' : status === 'closed' ? 'WHERE NOT open' : ''
  const { rows } = await pool.query(`SELECT doc FROM proj_hazards ${where} ORDER BY doc->>'detectedAt' DESC LIMIT 200`)
  return rows.map((r) => r.doc as HazardState)
}

export async function hazardDetail(id: string) {
  const { rows } = await pool.query<{ doc: HazardState }>('SELECT doc FROM proj_hazards WHERE key = $1', [id])
  const hazard = rows[0]?.doc
  if (!hazard) throw notFound('Hazard')
  const w = config.correlation.windowSeconds
  const r = config.correlation.radiusMiles
  const [events, evidence, nearby, notes, trainList, inspectors] = await Promise.all([
    pool.query('SELECT * FROM events WHERE stream_id = $1 ORDER BY stream_version', [`hazard-${id}`]),
    pool.query(`SELECT e.*, ee.lane, ee.recorded_at AS ingested_at, ee.source_id, ee.version AS schema_version FROM evidence e LEFT JOIN edge_events ee ON ee.event_id = e.event_id WHERE e.hazard_id = $1 ORDER BY e.occurred_at`, [id]),
    // Evidence near the hazard in space and time that did not join it: explained by a train, or a different hazard family.
    pool.query(
      `SELECT e.*, ee.lane, ee.recorded_at AS ingested_at, ee.source_id, ee.version AS schema_version FROM evidence e LEFT JOIN edge_events ee ON ee.event_id = e.event_id
       WHERE e.subdivision_id = $1 AND e.milepost BETWEEN $2 AND $3 AND e.occurred_at BETWEEN $4::timestamptz - make_interval(secs => $6) AND $5::timestamptz + make_interval(secs => $6)
         AND (e.hazard_id IS DISTINCT FROM $7) ORDER BY e.occurred_at LIMIT 30`,
      [hazard.subdivisionId, hazard.mpFrom - r * 2, hazard.mpTo + r * 2, hazard.firstEvidenceAt, hazard.lastEventAt, w * 2, id],
    ),
    pool.query('SELECT id, event_type, channel, recipient, status, attempts, message, created_at, delivered_at FROM notifications WHERE hazard_id = $1 ORDER BY created_at', [id]),
    trains(),
    pool.query(`SELECT username, display_name FROM users WHERE role = 'inspector' ORDER BY username`),
  ])
  const mapEvidence = (e: Record<string, unknown>) => ({
    eventId: e.event_id,
    kind: e.kind,
    sensorId: e.sensor_id,
    milepost: Number(e.milepost),
    occurredAt: iso(e.occurred_at as Date),
    ingestedAt: iso(e.ingested_at as Date),
    confidence: Number(e.confidence),
    late: e.late,
    lane: e.lane,
    gateway: e.source_id,
    schemaVersion: e.schema_version,
    explainedByTrain: e.explained_by_train,
    hazardId: e.hazard_id,
    expired: e.expired,
    details: e.details,
  })
  return {
    hazard,
    timeline: events.rows.map(rowToEnvelope),
    evidence: evidence.rows.map(mapEvidence),
    nearbyEvidence: nearby.rows.map(mapEvidence),
    notifications: notes.rows.map((n) => ({ id: n.id, eventType: n.event_type, channel: n.channel, recipient: n.recipient, status: n.status, attempts: n.attempts, message: n.message, createdAt: iso(n.created_at), deliveredAt: iso(n.delivered_at) })),
    approachingTrains: hazard.open ? approachingTrains(hazard, trainList.filter((t) => t.subdivisionId === hazard.subdivisionId), config.alerting) : [],
    inspectors: inspectors.rows.map((i) => ({ username: i.username, displayName: i.display_name })),
    window: { seconds: w, radiusMiles: r },
    serverTime: new Date().toISOString(),
  }
}

export async function alerts(user: SessionUser, scope: 'mine' | 'all', includeClosed: boolean) {
  const params: unknown[] = []
  const where: string[] = [includeClosed ? `status <> 'pending'` : `status IN ('open', 'acknowledged')`]
  if (scope === 'mine' && user.role === 'dispatcher') {
    params.push(user.deskId)
    where.push(`desk_id = $${params.length}`)
  }
  if (user.role === 'inspector') {
    params.push(user.username)
    where.push(`doc->>'inspector' = $${params.length}`)
  }
  const { rows } = await pool.query(`SELECT doc FROM proj_alerts WHERE ${where.join(' AND ')} ORDER BY (status = 'open') DESC, doc->>'issuedAt' DESC LIMIT 200`, params)
  return { alerts: rows.map((r) => r.doc), serverTime: new Date().toISOString() }
}

export async function restrictions(status: 'active' | 'all') {
  const { rows } = await pool.query(
    `SELECT r.doc, h.doc->>'code' AS code, h.doc->>'kind' AS kind FROM proj_restrictions r LEFT JOIN proj_hazards h ON h.key = r.doc->>'hazardId'
     ${status === 'active' ? 'WHERE r.active' : ''} ORDER BY r.active DESC, r.doc->>'issuedAt' DESC LIMIT 200`,
  )
  return rows.map((r) => ({ ...r.doc, hazardCode: r.code, hazardKind: r.kind }))
}

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

const summary = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b)
  return { count: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1) ?? null }
}

export async function latency() {
  const [alertRows, decisionRows] = await Promise.all([
    pool.query(
      `SELECT l.*, h.doc->>'code' AS code, h.doc->>'kind' AS kind, h.doc->>'severity' AS severity FROM latency_samples l LEFT JOIN proj_hazards h ON h.key = l.hazard_id
       WHERE l.kind = 'alert' ORDER BY l.created_at DESC LIMIT 500`,
    ),
    pool.query(`SELECT lane, late, total_ms, EXTRACT(EPOCH FROM (detected_at - ingested_at)) * 1000 AS cloud_ms FROM latency_samples WHERE kind = 'decision' AND created_at > now() - interval '6 hours'`),
  ])
  const ms = (a: Date | null, b: Date | null) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : null)
  const samples = alertRows.rows.map((r) => ({
    hazardId: r.hazard_id,
    code: r.code,
    kind: r.kind,
    severity: r.severity,
    lane: r.lane,
    late: r.late,
    totalMs: r.total_ms,
    stages: {
      edgeToIngest: ms(r.edge_occurred_at, r.ingested_at),
      ingestToDetect: ms(r.ingested_at, r.detected_at),
      detectToAlert: ms(r.detected_at, r.alert_issued_at),
      alertToDelivered: ms(r.alert_issued_at, r.delivered_at),
    },
    deliveredAt: iso(r.delivered_at),
  }))
  const live = samples.filter((s) => !s.late)
  const stageSummary = (key: keyof (typeof samples)[number]['stages']) => summary(live.map((s) => s.stages[key]).filter((v): v is number => v !== null))
  const byLane = (lane: string) => {
    const rows = decisionRows.rows.filter((r) => r.lane === lane)
    return { cloud: summary(rows.map((r) => Number(r.cloud_ms))), total: summary(rows.filter((r) => !r.late).map((r) => Number(r.total_ms))), late: rows.filter((r) => r.late).length }
  }
  return {
    budgetMs: 5000,
    alerts: { live: summary(live.map((s) => s.totalMs)), late: summary(samples.filter((s) => s.late).map((s) => s.totalMs)) },
    stages: { edgeToIngest: stageSummary('edgeToIngest'), ingestToDetect: stageSummary('ingestToDetect'), detectToAlert: stageSummary('detectToAlert'), alertToDelivered: stageSummary('alertToDelivered') },
    decisions: { critical: byLane('critical'), bulk: byLane('bulk'), trains: byLane('trains') },
    histogram: live.map((s) => s.totalMs),
    samples: samples.slice(0, 25),
  }
}

export async function eventLog(opts: { type?: string; streamId?: string; correlationId?: string; before?: number; limit: number }) {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.type) {
    params.push(opts.type)
    where.push(`type = $${params.length}`)
  }
  if (opts.streamId) {
    params.push(opts.streamId)
    where.push(`stream_id = $${params.length}`)
  }
  if (opts.correlationId) {
    params.push(opts.correlationId)
    where.push(`correlation_id = $${params.length}`)
  }
  if (opts.before) {
    params.push(opts.before)
    where.push(`global_position < $${params.length}`)
  }
  params.push(opts.limit)
  const { rows } = await pool.query(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY global_position DESC LIMIT $${params.length}`, params)
  const counts = await pool.query<{ type: string; n: number }>('SELECT type, count(*)::int AS n FROM events GROUP BY type ORDER BY type')
  return { events: rows.map(rowToEnvelope), counts: counts.rows }
}
