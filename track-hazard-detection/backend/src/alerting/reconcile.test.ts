import { describe, expect, it } from 'vitest'
import type { Envelope } from '../shared/events/envelope.js'
import type { DomainEventDraft } from '../shared/events/domain.js'
import { foldHazard } from '../shared/hazard.js'
import { approachingTrains, desiredTimer, reconcile, type ReconcileContext } from './reconcile.js'

const T0 = Date.UTC(2026, 10, 6, 20, 0, 0)
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const cfg = { ackSeconds: { CRITICAL: 60, HIGH: 180, MEDIUM: 600, LOW: 1800 }, maxEscalationLevel: 2, approachMiles: 30, approachMinutes: 40 }
const trains = [
  { trainId: 'Z', symbol: 'Z-CHIPRA', milepost: 256.2, direction: 'decreasing' as const, speedMph: 55, occurredAt: at(0) },
  { trainId: 'M', symbol: 'M-PRACAN', milepost: 215.7, direction: 'increasing' as const, speedMph: 40, occurredAt: at(0) },
  { trainId: 'X', symbol: 'X-PAST', milepost: 230, direction: 'decreasing' as const, speedMph: 50, occurredAt: at(0) },
]
const ctx = (s: number): ReconcileContext => ({ now: new Date(T0 + s * 1000), trains, deskId: 'EAST', assignee: 'dan', cfg, heat: { elevatedSpeedMph: 40, criticalSpeedMph: 25 } })

let version = 0
function env(d: DomainEventDraft, s: number): Envelope {
  version += 1
  return { eventId: `e${version}`, type: d.type, version: 1, occurredAt: at(s), recordedAt: at(s), streamId: 'hazard-h1', streamVersion: version, partitionKey: 'PRA-7', correlationId: 'c', causationId: null, source: 'test', meta: {}, payload: d.payload }
}

const detected = (severity: 'HIGH' | 'CRITICAL') => ({
  type: 'HazardDetected' as const,
  payload: { hazardId: 'h1', code: 'HZ-1008', kind: 'obstruction' as const, subdivisionId: 'PRA', segmentId: 'PRA-7', mpFrom: 241.3, mpTo: 241.5, confidence: severity === 'CRITICAL' ? 0.83 : 0.71, severity, detectionStatus: severity === 'CRITICAL' ? ('confirmed' as const) : ('detected' as const), evidence: [], late: false, trigger: { eventId: 'x', occurredAt: at(0), recordedAt: at(0), lane: 'critical', late: false } },
})

/** Applies the PM's decisions to the stream, as the real handler does. */
function step(stream: Envelope[], s: number): DomainEventDraft[] {
  const drafts = reconcile(foldHazard(stream), ctx(s))
  stream.push(...drafts.map((d) => env(d, s)))
  return drafts
}

describe('hazard response process manager', () => {
  it('orders approaching trains nearest first and ignores trains already past', () => {
    const list = approachingTrains({ mpFrom: 241.3, mpTo: 241.5 }, trains, cfg)
    expect(list.map((t) => t.symbol)).toEqual(['Z-CHIPRA', 'M-PRACAN'])
    expect(list[0].etaMinutes).toBeLessThan(list[1].etaMinutes)
  })

  it('issues one alert, warns approaching trains for a CRITICAL hazard, and is idempotent', () => {
    version = 0
    const stream = [env(detected('CRITICAL'), 0)]
    expect(step(stream, 1).map((d) => d.type)).toEqual(['AlertIssued', 'TrainsWarned'])
    // Redelivery or another wake-up: nothing left to do.
    expect(step(stream, 2)).toEqual([])
    expect(foldHazard(stream)!.alert).toMatchObject({ assignee: 'dan', deskId: 'EAST', severity: 'CRITICAL' })
  })

  it('escalates at the ack deadline up the chain and stops at the top', () => {
    version = 0
    const stream = [env(detected('HIGH'), 0)]
    step(stream, 0)
    expect(step(stream, 100)).toEqual([]) // before the 180 s deadline
    expect(step(stream, 181).map((d) => d.payload)).toMatchObject([{ reason: 'ack_overdue', level: 1, target: 'chief dispatcher' }])
    expect(step(stream, 362).map((d) => d.payload)).toMatchObject([{ reason: 'ack_overdue', level: 2, target: 'manager of operations' }])
    expect(step(stream, 1000)).toEqual([])
    expect(desiredTimer(foldHazard(stream), 2)).toBeNull()
  })

  it('re-alerts when a hazard gets worse, and warns trains once it is CRITICAL', () => {
    version = 0
    const stream = [env(detected('HIGH'), 0)]
    step(stream, 0)
    stream.push(env({ type: 'AlertAcknowledged', payload: { hazardId: 'h1', alertId: 'AL-1008', by: 'dan' } }, 10))
    expect(desiredTimer(foldHazard(stream), 2)).toBeNull()
    stream.push(env({ type: 'HazardUpgraded', payload: { hazardId: 'h1', fromSeverity: 'HIGH', toSeverity: 'CRITICAL', fromStatus: 'detected', toStatus: 'confirmed', confidence: 0.83, reason: 'late spike', late: true } }, 20))
    const drafts = step(stream, 21)
    expect(drafts.map((d) => d.type)).toEqual(['AlertEscalated', 'TrainsWarned'])
    expect(drafts[0].payload).toMatchObject({ reason: 'severity_raised', severity: 'CRITICAL' })
    expect(foldHazard(stream)!.alert!.acknowledgedAt).toBeNull() // the worse hazard needs a fresh acknowledgment
  })

  it('compensates when the hazard is a false alarm: lifts slow orders and releases trains', () => {
    version = 0
    const stream = [env(detected('CRITICAL'), 0)]
    step(stream, 1)
    stream.push(env({ type: 'SpeedRestrictionIssued', payload: { hazardId: 'h1', restrictionId: 'SR-1', subdivisionId: 'PRA', mpFrom: 240.8, mpTo: 242, maxSpeedMph: 10, reason: 'x', automatic: false, by: 'dan' } }, 30))
    stream.push(env({ type: 'HazardConfirmedFalseAlarm', payload: { hazardId: 'h1', by: 'dan', note: 'shadow' } }, 60))
    const drafts = step(stream, 61)
    expect(drafts.map((d) => d.type)).toEqual(['SpeedRestrictionLifted', 'TrainsReleased'])
    expect(step(stream, 62)).toEqual([])
    const s = foldHazard(stream)!
    expect(s.responseStatus).toBe('false_alarm')
    expect(s.restrictions.every((r) => r.liftedAt)).toBe(true)
  })

  it('puts a standing heat order on an elevated rail-buckling risk', () => {
    version = 0
    const stream = [
      env(
        { type: 'HazardRiskElevated', payload: { hazardId: 'h1', code: 'HZ-2', kind: 'rail_buckling_risk', subdivisionId: 'PRA', segmentId: 'PRA-3', mpFrom: 200, mpTo: 210, band: 'elevated', severity: 'MEDIUM', sensorId: 'RTS-205.0', railTempF: 126, neutralTempF: 95, projectedTempF: 131, slopeFPerMin: 0.5, trigger: { eventId: 'x', occurredAt: at(0), recordedAt: at(0), lane: 'bulk', late: false } } },
        0,
      ),
    ]
    const drafts = step(stream, 1)
    expect(drafts.map((d) => d.type)).toEqual(['AlertIssued', 'SpeedRestrictionIssued'])
    expect(drafts[1].payload).toMatchObject({ maxSpeedMph: 40, automatic: true })
    stream.push(env({ type: 'HazardRiskSubsided', payload: { hazardId: 'h1', railTempF: 110, projectedTempF: 110 } }, 600))
    expect(step(stream, 601).map((d) => d.type)).toEqual(['SpeedRestrictionLifted', 'HazardCleared'])
  })
})
