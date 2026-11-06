import { describe, expect, it } from 'vitest'
import type { Envelope } from '../shared/events/envelope.js'
import { alertsProjection, coverageProjection, foldProjection, hazardsProjection, PROJECTIONS, restrictionsProjection, type Doc } from './projections.js'

const T0 = Date.UTC(2026, 10, 6, 20, 0, 0)
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
let pos = 0
const versions = new Map<string, number>()
function e(streamId: string, type: string, payload: Record<string, unknown>, s: number): Envelope {
  pos += 1
  const v = (versions.get(streamId) ?? 0) + 1
  versions.set(streamId, v)
  return { eventId: `e${pos}`, type, version: 1, occurredAt: at(s), recordedAt: at(s), streamId, streamVersion: v, partitionKey: 'CAN-5', correlationId: 'c', causationId: null, source: 't', globalPosition: pos, meta: {}, payload }
}

function history(): Envelope[] {
  pos = 0
  versions.clear()
  const h = 'hazard-a'
  const g = 'hazard-b'
  const trig = { eventId: 'x', occurredAt: at(0), recordedAt: at(0), lane: 'critical', late: false }
  return [
    e(h, 'HazardDetected', { hazardId: 'a', code: 'HZ-1', kind: 'rockfall', subdivisionId: 'CAN', segmentId: 'CAN-5', mpFrom: 147.8, mpTo: 147.8, confidence: 0.85, severity: 'CRITICAL', detectionStatus: 'confirmed', evidence: [], late: false, trigger: trig }, 0),
    e(g, 'HazardDetected', { hazardId: 'b', code: 'HZ-2', kind: 'obstruction', subdivisionId: 'PRA', segmentId: 'PRA-7', mpFrom: 241.3, mpTo: 241.3, confidence: 0.71, severity: 'HIGH', detectionStatus: 'detected', evidence: [], late: false, trigger: trig }, 1),
    e(h, 'AlertIssued', { hazardId: 'a', alertId: 'AL-1', severity: 'CRITICAL', deskId: 'WEST', assignee: 'alice', ackDeadlineAt: at(60), summary: 's', lane: 'critical', late: false, timing: { edgeOccurredAt: at(0), ingestedAt: at(0), detectedAt: at(0) } }, 1),
    e('sensor-GEO-122.0', 'CoverageDegraded', { scope: 'sensor', targetId: 'GEO-122.0', subdivisionId: 'CAN', segmentId: 'CAN-3', mpFrom: 121, mpTo: 123, reason: 'heartbeat_missed', since: at(0) }, 2),
    e(h, 'SpeedRestrictionIssued', { hazardId: 'a', restrictionId: 'SR-1', subdivisionId: 'CAN', mpFrom: 147.3, mpTo: 148.3, maxSpeedMph: 10, reason: 'r', automatic: false, by: 'alice' }, 3),
    e(g, 'HazardUpgraded', { hazardId: 'b', fromSeverity: 'HIGH', toSeverity: 'CRITICAL', fromStatus: 'detected', toStatus: 'confirmed', confidence: 0.83, reason: 'spike', late: false }, 4),
    e(h, 'AlertAcknowledged', { hazardId: 'a', alertId: 'AL-1', by: 'alice' }, 5),
    e(h, 'HazardCleared', { hazardId: 'a', by: 'bob', note: 'rocks removed' }, 6),
    e(h, 'SpeedRestrictionLifted', { hazardId: 'a', restrictionId: 'SR-1', reason: 'hazard cleared', by: 'alerting' }, 7),
  ]
}

/** What the live projector does: one event at a time, skipping versions already applied. */
function applyLive(events: Envelope[]) {
  const out: Record<string, Map<string, Doc>> = {}
  for (const p of PROJECTIONS) {
    const docs = new Map<string, Doc>()
    const versions = new Map<string, number>()
    for (const env of events) {
      if (!p.handles(env) || (versions.get(env.streamId) ?? 0) >= env.streamVersion) continue
      const current = new Map(p.keys(env).map((k) => [k, docs.has(k) ? (JSON.parse(JSON.stringify(docs.get(k))) as Doc) : undefined]))
      for (const { key, doc } of p.apply(env, current)) docs.set(key, JSON.parse(JSON.stringify(doc)))
      versions.set(env.streamId, env.streamVersion)
    }
    out[p.name] = docs
  }
  return out
}

describe('projections', () => {
  it('replay from position 0 equals the live projection, even with redeliveries and partitions interleaved', () => {
    const events = history()
    // Live: at-least-once delivery means duplicates; partitions interleave streams differently from global order.
    const live = applyLive([events[0], events[1], events[0], events[3], events[2], events[5], events[4], events[4], events[6], events[1], events[7], events[8], events[8]])
    for (const p of PROJECTIONS) {
      const replayed = foldProjection(p, events).docs
      const normalise = (m: Map<string, Doc>) => JSON.stringify([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
      expect(normalise(live[p.name])).toEqual(normalise(replayed))
    }
  })

  it('derives the read models', () => {
    const events = history()
    const hazards = foldProjection(hazardsProjection, events).docs
    expect(hazards.get('a')).toMatchObject({ open: false, responseStatus: 'cleared', closedBy: 'bob' })
    expect(hazards.get('b')).toMatchObject({ open: true, severity: 'CRITICAL', detectionStatus: 'confirmed' })
    expect(foldProjection(alertsProjection, events).docs.get('a')).toMatchObject({ status: 'closed', outcome: 'cleared', acknowledgedBy: 'alice' })
    expect(foldProjection(restrictionsProjection, events).docs.get('SR-1')).toMatchObject({ active: false, liftedBy: 'alerting' })
    expect(foldProjection(coverageProjection, events).docs.get('sensor:GEO-122.0')).toMatchObject({ status: 'degraded', segmentId: 'CAN-3' })
  })
})
