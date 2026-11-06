/**
 * PostgreSQL CorrelatorStore. Every method runs on the consumer's transaction
 * client, so evidence rows, the hazard index, the appended hazard events, their
 * outbox rows and the processed-events mark commit (or roll back) together.
 * @module correlator/pg-store
 */
import { randomUUID } from 'node:crypto'
import type { Client } from '../shared/db.js'
import { appendToStream } from '../shared/event-store.js'
import type { DomainEventDraft } from '../shared/events/domain.js'
import type { Envelope } from '../shared/events/envelope.js'
import type { CorrelatorStore, Trigger } from './engine.js'
import type { Sample } from './heat.js'
import type { Evidence, HazardRecord, TrainFix } from './rules.js'

interface EvidenceRow {
  event_id: string
  kind: Evidence['kind']
  sensor_id: string
  subdivision_id: string
  segment_id: string
  milepost: number
  occurred_at: Date
  confidence: number
  late: boolean
  explained_by_train: string | null
  hazard_id: string | null
  details: Record<string, unknown>
}

const toEvidence = (r: EvidenceRow): Evidence => ({
  eventId: r.event_id,
  kind: r.kind,
  sensorId: r.sensor_id,
  subdivisionId: r.subdivision_id,
  segmentId: r.segment_id,
  milepost: Number(r.milepost),
  occurredAt: new Date(r.occurred_at).toISOString(),
  confidence: Number(r.confidence),
  late: r.late,
  explainedByTrain: r.explained_by_train,
  hazardId: r.hazard_id,
  details: r.details ?? {},
})

interface HazardRow {
  hazard_id: string
  code: string
  kind: HazardRecord['kind']
  subdivision_id: string
  segment_id: string
  mp_from: number
  mp_to: number
  confidence: number
  severity: HazardRecord['severity']
  detection_status: HazardRecord['detectionStatus']
  first_evidence_at: Date
  stream_version: number
}

const toHazard = (r: HazardRow): HazardRecord => ({
  hazardId: r.hazard_id,
  code: r.code,
  kind: r.kind,
  subdivisionId: r.subdivision_id,
  segmentId: r.segment_id,
  mpFrom: Number(r.mp_from),
  mpTo: Number(r.mp_to),
  confidence: Number(r.confidence),
  severity: r.severity,
  detectionStatus: r.detection_status,
  firstEvidenceAt: new Date(r.first_evidence_at).toISOString(),
  streamVersion: r.stream_version,
})

interface TrainRow {
  train_id: string
  symbol: string
  milepost: number
  direction: TrainFix['direction']
  speed_mph: number
  occurred_at: Date
}

const toFix = (r: TrainRow): TrainFix => ({
  trainId: r.train_id,
  symbol: r.symbol,
  milepost: Number(r.milepost),
  direction: r.direction,
  speedMph: Number(r.speed_mph),
  occurredAt: new Date(r.occurred_at).toISOString(),
})

const CLOSED = `EXISTS (SELECT 1 FROM events e WHERE e.stream_id = 'hazard-' || ch.hazard_id AND e.type IN ('HazardCleared', 'HazardConfirmedFalseAlarm'))`

export class PgCorrelatorStore implements CorrelatorStore {
  /** Events appended during this transaction (for metrics after commit). */
  readonly appended: Envelope[] = []

  constructor(private client: Client) {}

  async nearbyEvidence(sub: string, mpFrom: number, mpTo: number, fromIso: string, toIso: string): Promise<Evidence[]> {
    const { rows } = await this.client.query<EvidenceRow>(
      'SELECT * FROM evidence WHERE subdivision_id = $1 AND milepost BETWEEN $2 AND $3 AND occurred_at BETWEEN $4 AND $5 ORDER BY occurred_at, event_id',
      [sub, mpFrom, mpTo, fromIso, toIso],
    )
    return rows.map(toEvidence)
  }

  async openHazardsNear(sub: string, mpFrom: number, mpTo: number): Promise<HazardRecord[]> {
    const { rows } = await this.client.query<HazardRow>(`SELECT * FROM correlation_hazards ch WHERE subdivision_id = $1 AND mp_to >= $2 AND mp_from <= $3 AND NOT ${CLOSED}`, [sub, mpFrom, mpTo])
    return rows.map(toHazard)
  }

  async hazardEvidence(hazardId: string): Promise<Evidence[]> {
    const { rows } = await this.client.query<EvidenceRow>('SELECT * FROM evidence WHERE hazard_id = $1 ORDER BY occurred_at, event_id', [hazardId])
    return rows.map(toEvidence)
  }

  async hazardRecord(hazardId: string): Promise<HazardRecord | null> {
    const { rows } = await this.client.query<HazardRow>('SELECT * FROM correlation_hazards WHERE hazard_id = $1', [hazardId])
    return rows[0] ? toHazard(rows[0]) : null
  }

  async saveEvidence(e: Evidence): Promise<void> {
    await this.client.query(
      `INSERT INTO evidence (event_id, kind, sensor_id, subdivision_id, segment_id, milepost, occurred_at, confidence, late, explained_by_train, hazard_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (event_id) DO NOTHING`,
      [e.eventId, e.kind, e.sensorId, e.subdivisionId, e.segmentId, e.milepost, e.occurredAt, e.confidence, e.late, e.explainedByTrain, e.hazardId, e.details],
    )
  }

  async updateEvidence(ids: string[], patch: { hazardId?: string | null; explainedByTrain?: string | null }): Promise<void> {
    if (ids.length === 0) return
    if (patch.hazardId !== undefined) await this.client.query('UPDATE evidence SET hazard_id = $2, expired = false WHERE event_id = ANY($1::uuid[])', [ids, patch.hazardId])
    if (patch.explainedByTrain !== undefined) await this.client.query('UPDATE evidence SET explained_by_train = $2 WHERE event_id = ANY($1::uuid[])', [ids, patch.explainedByTrain])
  }

  async saveHazard(h: HazardRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO correlation_hazards (hazard_id, code, kind, subdivision_id, segment_id, mp_from, mp_to, confidence, severity, detection_status, first_evidence_at, stream_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (hazard_id) DO UPDATE SET mp_from = EXCLUDED.mp_from, mp_to = EXCLUDED.mp_to, confidence = EXCLUDED.confidence, severity = EXCLUDED.severity,
         detection_status = EXCLUDED.detection_status, first_evidence_at = EXCLUDED.first_evidence_at, stream_version = EXCLUDED.stream_version`,
      [h.hazardId, h.code, h.kind, h.subdivisionId, h.segmentId, h.mpFrom, h.mpTo, h.confidence, h.severity, h.detectionStatus, h.firstEvidenceAt, h.streamVersion],
    )
  }

  async newHazard(): Promise<{ hazardId: string; code: string }> {
    const { rows } = await this.client.query<{ n: number }>(`SELECT nextval('hazard_code_seq') AS n`)
    return { hazardId: randomUUID(), code: `HZ-${rows[0].n}` }
  }

  async appendHazard(h: HazardRecord, drafts: DomainEventDraft[], trigger: Trigger): Promise<number> {
    const envs = await appendToStream(this.client, `hazard-${h.hazardId}`, h.streamVersion, drafts, {
      partitionKey: h.segmentId,
      source: 'correlator',
      correlationId: trigger.correlationId,
      causationId: trigger.eventId,
      meta: { actor: 'correlator', segmentId: h.segmentId, subdivisionId: h.subdivisionId },
    })
    this.appended.push(...envs)
    return h.streamVersion + drafts.length
  }

  async trainFixesAround(sub: string, atIso: string): Promise<Array<{ before: TrainFix | null; after: TrainFix | null }>> {
    const before = await this.client.query<TrainRow>(
      `SELECT DISTINCT ON (train_id) * FROM train_positions WHERE subdivision_id = $1 AND occurred_at <= $2 AND occurred_at >= $2::timestamptz - interval '150 seconds'
       ORDER BY train_id, occurred_at DESC`,
      [sub, atIso],
    )
    const after = await this.client.query<TrainRow>(
      `SELECT DISTINCT ON (train_id) * FROM train_positions WHERE subdivision_id = $1 AND occurred_at > $2 AND occurred_at <= $2::timestamptz + interval '150 seconds'
       ORDER BY train_id, occurred_at ASC`,
      [sub, atIso],
    )
    const byTrain = new Map<string, { before: TrainFix | null; after: TrainFix | null }>()
    for (const r of before.rows) byTrain.set(r.train_id, { before: toFix(r), after: null })
    for (const r of after.rows) byTrain.set(r.train_id, { before: byTrain.get(r.train_id)?.before ?? null, after: toFix(r) })
    return [...byTrain.values()]
  }

  async trainFixesAdjacent(trainId: string, atIso: string): Promise<{ before: TrainFix | null; after: TrainFix | null }> {
    const b = await this.client.query<TrainRow>('SELECT * FROM train_positions WHERE train_id = $1 AND occurred_at < $2 ORDER BY occurred_at DESC LIMIT 1', [trainId, atIso])
    const a = await this.client.query<TrainRow>('SELECT * FROM train_positions WHERE train_id = $1 AND occurred_at > $2 ORDER BY occurred_at ASC LIMIT 1', [trainId, atIso])
    return { before: b.rows[0] ? toFix(b.rows[0]) : null, after: a.rows[0] ? toFix(a.rows[0]) : null }
  }

  async unexplainedVibration(sub: string, mpFrom: number, mpTo: number, fromIso: string, toIso: string): Promise<Evidence[]> {
    const { rows } = await this.client.query<EvidenceRow>(
      `SELECT * FROM evidence WHERE subdivision_id = $1 AND kind = 'ground_vibration' AND explained_by_train IS NULL
         AND milepost BETWEEN $2 AND $3 AND occurred_at BETWEEN $4 AND $5`,
      [sub, mpFrom, mpTo, fromIso, toIso],
    )
    return rows.map(toEvidence)
  }

  async railTempSamples(sensorId: string, sinceIso: string): Promise<Sample[]> {
    const { rows } = await this.client.query<{ occurred_at: Date; temp_f: number }>('SELECT occurred_at, temp_f FROM rail_temp_samples WHERE sensor_id = $1 AND occurred_at >= $2 ORDER BY occurred_at', [sensorId, sinceIso])
    return rows.map((r) => ({ occurredAt: new Date(r.occurred_at).toISOString(), tempF: Number(r.temp_f) }))
  }

  async addRailTempSample(sensorId: string, s: Sample): Promise<void> {
    await this.client.query('INSERT INTO rail_temp_samples (sensor_id, occurred_at, temp_f) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [sensorId, s.occurredAt, s.tempF])
  }

  async heatState(segmentId: string): Promise<{ band: string; hazardId: string | null } | null> {
    const { rows } = await this.client.query<{ band: string; hazard_id: string | null }>('SELECT band, hazard_id FROM heat_state WHERE segment_id = $1', [segmentId])
    return rows[0] ? { band: rows[0].band, hazardId: rows[0].hazard_id } : null
  }

  async setHeatState(segmentId: string, band: string, hazardId: string | null): Promise<void> {
    await this.client.query(
      `INSERT INTO heat_state (segment_id, band, hazard_id, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (segment_id) DO UPDATE SET band = EXCLUDED.band, hazard_id = EXCLUDED.hazard_id, updated_at = now()`,
      [segmentId, band, hazardId],
    )
  }

  async hazardStreamState(hazardId: string): Promise<{ open: boolean; version: number } | null> {
    const { rows } = await this.client.query<{ v: number | null; closed: boolean | null }>(
      `SELECT max(stream_version) AS v, bool_or(type IN ('HazardCleared', 'HazardConfirmedFalseAlarm')) AS closed FROM events WHERE stream_id = $1`,
      [`hazard-${hazardId}`],
    )
    if (!rows[0] || rows[0].v === null) return null
    return { open: !rows[0].closed, version: rows[0].v }
  }
}
