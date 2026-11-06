/**
 * Projection definitions. Each projection is a pure reducer from (current
 * documents, event) to updated documents, plus the typed columns its table
 * indexes. The live projector and the replay command call the same `apply`,
 * which is why a rebuild from position 0 reproduces the live read model.
 * @module projector/projections
 */
import type { Envelope } from '../shared/events/envelope.js'
import type { DomainPayload } from '../shared/events/domain.js'
import { reduceHazard, type HazardState } from '../shared/hazard.js'

export type Doc = Record<string, unknown>

export interface Projection {
  name: 'hazards' | 'alerts' | 'restrictions' | 'coverage'
  table: string
  /** Which streams this projection follows (its version bookkeeping is per stream). */
  handles(env: Envelope): boolean
  /** Document keys this event touches. */
  keys(env: Envelope): string[]
  apply(env: Envelope, current: Map<string, Doc | undefined>): Array<{ key: string; doc: Doc }>
  columns(doc: Doc): unknown[]
  columnNames: string[]
}

const isHazardStream = (env: Envelope) => env.streamId.startsWith('hazard-')
const hazardIdOf = (env: Envelope) => env.streamId.slice('hazard-'.length)

export const hazardsProjection: Projection = {
  name: 'hazards',
  table: 'proj_hazards',
  handles: isHazardStream,
  keys: (env) => [hazardIdOf(env)],
  apply(env, current) {
    const key = hazardIdOf(env)
    const next = reduceHazard((current.get(key) as HazardState | undefined) ?? null, env)
    return next ? [{ key, doc: next as unknown as Doc }] : []
  },
  columnNames: ['subdivision_id', 'open', 'severity'],
  columns: (d) => [d.subdivisionId, d.open, d.severity],
}

/** The alert queue: one row per hazard, with the routing and acknowledgment state the dispatcher works from. */
export const alertsProjection: Projection = {
  name: 'alerts',
  table: 'proj_alerts',
  handles: isHazardStream,
  keys: (env) => [hazardIdOf(env)],
  apply(env, current) {
    const key = hazardIdOf(env)
    const prev = current.get(key) as Doc | undefined
    const p = env.payload as Record<string, unknown>
    let doc: Doc | undefined = prev ? { ...prev } : undefined
    switch (env.type) {
      case 'HazardDetected':
      case 'HazardRiskElevated': {
        const d = p as unknown as DomainPayload<'HazardDetected'>
        doc = { ...(doc ?? { status: 'pending', escalationLevel: 0, history: [] }), hazardId: key, code: d.code, kind: d.kind, subdivisionId: d.subdivisionId, mpFrom: d.mpFrom, mpTo: d.mpTo, severity: d.severity }
        break
      }
      case 'HazardEvidenceAdded':
        if (doc) doc = { ...doc, mpFrom: p.mpFrom, mpTo: p.mpTo }
        break
      case 'HazardUpgraded':
      case 'HazardDowngraded':
        if (doc) doc = { ...doc, severity: p.toSeverity }
        break
      case 'AlertIssued':
        if (doc) doc = { ...doc, status: 'open', alertId: p.alertId, deskId: p.deskId, assignee: p.assignee, alertSeverity: p.severity, issuedAt: env.recordedAt, ackDeadlineAt: p.ackDeadlineAt, summary: p.summary, late: p.late }
        break
      case 'AlertEscalated':
        if (doc) {
          doc = { ...doc, escalationLevel: p.level, escalationTarget: p.target, ackDeadlineAt: p.ackDeadlineAt, alertSeverity: p.severity }
          if (p.reason === 'severity_raised') doc = { ...doc, status: 'open', acknowledgedAt: null, acknowledgedBy: null }
        }
        break
      case 'AlertAcknowledged':
        if (doc && doc.status === 'open') doc = { ...doc, status: 'acknowledged', acknowledgedAt: env.occurredAt, acknowledgedBy: p.by }
        break
      case 'InspectorDispatched':
        if (doc) doc = { ...doc, inspector: p.inspector, inspectorName: p.inspectorName }
        break
      case 'HazardCleared':
      case 'HazardConfirmedFalseAlarm':
        if (doc) doc = { ...doc, status: 'closed', outcome: env.type === 'HazardCleared' ? 'cleared' : 'false_alarm', closedAt: env.occurredAt }
        break
      default:
        break
    }
    if (!doc) return []
    doc.version = env.streamVersion
    return [{ key, doc }]
  },
  columnNames: ['desk_id', 'status'],
  columns: (d) => [d.deskId ?? '', d.status],
}

/** Speed restrictions (slow orders), one row per restriction id. */
export const restrictionsProjection: Projection = {
  name: 'restrictions',
  table: 'proj_restrictions',
  handles: isHazardStream,
  keys: (env) => {
    const id = (env.payload as { restrictionId?: string }).restrictionId
    return (env.type === 'SpeedRestrictionIssued' || env.type === 'SpeedRestrictionLifted') && id ? [id] : []
  },
  apply(env, current) {
    const p = env.payload as Record<string, unknown>
    const key = String(p.restrictionId ?? '')
    if (env.type === 'SpeedRestrictionIssued') {
      return [{ key, doc: { restrictionId: key, hazardId: p.hazardId, subdivisionId: p.subdivisionId, mpFrom: p.mpFrom, mpTo: p.mpTo, maxSpeedMph: p.maxSpeedMph, reason: p.reason, automatic: p.automatic, issuedBy: p.by, issuedAt: env.occurredAt, active: true, liftedAt: null, liftedBy: null, liftReason: null } }]
    }
    if (env.type === 'SpeedRestrictionLifted') {
      const prev = current.get(key)
      if (!prev) return []
      return [{ key, doc: { ...prev, active: false, liftedAt: env.occurredAt, liftedBy: p.by, liftReason: p.reason } }]
    }
    return []
  },
  columnNames: ['subdivision_id', 'active'],
  columns: (d) => [d.subdivisionId, d.active],
}

/** Coverage: one row per sensor or gateway currently or previously degraded. */
export const coverageProjection: Projection = {
  name: 'coverage',
  table: 'proj_coverage',
  handles: (env) => env.streamId.startsWith('sensor-') || env.streamId.startsWith('gateway-'),
  keys: (env) => {
    const p = env.payload as { scope?: string; targetId?: string }
    return p.scope && p.targetId ? [`${p.scope}:${p.targetId}`] : []
  },
  apply(env, current) {
    const p = env.payload as Record<string, unknown>
    const key = `${p.scope}:${p.targetId}`
    const prev = current.get(key) ?? { degradedCount: 0 }
    if (env.type === 'CoverageDegraded') {
      return [{ key, doc: { ...prev, key, scope: p.scope, targetId: p.targetId, subdivisionId: p.subdivisionId, segmentId: p.segmentId, mpFrom: p.mpFrom, mpTo: p.mpTo, status: 'degraded', reason: p.reason, since: p.since, restoredAt: null, degradedCount: Number(prev.degradedCount ?? 0) + 1 } }]
    }
    if (env.type === 'CoverageRestored') {
      return [{ key, doc: { ...prev, key, scope: p.scope, targetId: p.targetId, subdivisionId: p.subdivisionId, segmentId: p.segmentId, status: 'ok', restoredAt: p.restoredAt } }]
    }
    return []
  },
  columnNames: ['segment_id', 'status'],
  columns: (d) => [d.segmentId, d.status],
}

export const PROJECTIONS: Projection[] = [hazardsProjection, alertsProjection, restrictionsProjection, coverageProjection]
export const projectionByName = (name: string) => PROJECTIONS.find((p) => p.name === name)

/** Folds events in order through a projection in memory (replay, and the tests). */
export function foldProjection(projection: Projection, events: Envelope[]): { docs: Map<string, Doc>; versions: Map<string, number> } {
  const docs = new Map<string, Doc>()
  const versions = new Map<string, number>()
  for (const env of events) {
    if (!projection.handles(env)) continue
    if ((versions.get(env.streamId) ?? 0) >= env.streamVersion) continue // already applied (redelivery)
    const current = new Map(projection.keys(env).map((k) => [k, docs.get(k)]))
    for (const { key, doc } of projection.apply(env, current)) docs.set(key, doc)
    versions.set(env.streamId, env.streamVersion)
  }
  return { docs, versions }
}
