/**
 * The hazard-response process manager's decision function. Pure: given the
 * folded hazard state, the trains near it and the time, it returns the events
 * that should be appended next.
 *
 * It is level-triggered, not edge-triggered: it compares what *should* be true
 * with what the stream says *is* true, whatever event woke it up. That makes
 * it idempotent by construction (a redelivered or reordered wake-up finds
 * nothing left to do) and lets one function serve domain events, ack-deadline
 * timers and train movements.
 *
 * Forward steps: AlertIssued -> AlertEscalated (deadline or worse severity) ->
 * TrainsWarned (CRITICAL: approaching trains, nearest first) ->
 * SpeedRestrictionIssued (heat risk: standing heat order).
 * Compensation when the hazard closes (cleared or false alarm): lift every
 * active restriction and release every warned train. Nothing is relaxed
 * automatically while the hazard is open, even if it is downgraded.
 * @module alerting/reconcile
 */
import { randomUUID } from 'node:crypto'
import type { DomainEventDraft, Severity, WarnedTrain } from '../shared/events/domain.js'
import { draft, severityRank } from '../shared/events/domain.js'
import { activeRestrictions, activeWarnings, type HazardState } from '../shared/hazard.js'
import type { TrainFix } from '../correlator/rules.js'

export interface AlertingConfig {
  ackSeconds: Record<Severity, number>
  maxEscalationLevel: number
  approachMiles: number
  approachMinutes: number
}

export interface HeatSpeeds {
  elevatedSpeedMph: number
  criticalSpeedMph: number
}

export interface ReconcileContext {
  now: Date
  /** Latest position of each train on the hazard's subdivision. */
  trains: TrainFix[]
  /** The dispatcher on duty for the desk that owns the territory. */
  deskId: string
  assignee: string | null
  cfg: AlertingConfig
  heat: HeatSpeeds
  actor?: string
}

export const ESCALATION_TARGETS = ['desk dispatcher', 'chief dispatcher', 'manager of operations']

const KIND_LABEL: Record<string, string> = { rockfall: 'Rockfall', obstruction: 'Obstruction on track', high_water: 'High water', rail_buckling_risk: 'Rail buckling risk (heat)' }

export function summaryOf(s: HazardState): string {
  const where = s.mpFrom === s.mpTo ? `MP ${s.mpFrom.toFixed(1)}` : `MP ${s.mpFrom.toFixed(1)}-${s.mpTo.toFixed(1)}`
  const extra = s.heat ? `, rail ${s.heat.railTempF}°F (RNT ${s.heat.neutralTempF}°F)` : `, confidence ${s.confidence.toFixed(2)}`
  return `${KIND_LABEL[s.kind] ?? s.kind} ${where} (${s.subdivisionId}${extra})`
}

/** Trains heading into the hazard's limits within the approach window, nearest (by ETA) first. */
export function approachingTrains(s: Pick<HazardState, 'mpFrom' | 'mpTo'>, trains: TrainFix[], cfg: Pick<AlertingConfig, 'approachMiles' | 'approachMinutes'>): WarnedTrain[] {
  const out: WarnedTrain[] = []
  for (const t of trains) {
    let distance: number | null = null
    if (t.milepost >= s.mpFrom && t.milepost <= s.mpTo) distance = 0
    else if (t.direction === 'increasing' && t.milepost < s.mpFrom) distance = s.mpFrom - t.milepost
    else if (t.direction === 'decreasing' && t.milepost > s.mpTo) distance = t.milepost - s.mpTo
    if (distance === null) continue
    const eta = t.speedMph > 0 ? (distance / t.speedMph) * 60 : distance === 0 ? 0 : Number.POSITIVE_INFINITY
    if (distance > cfg.approachMiles && eta > cfg.approachMinutes) continue
    if (!Number.isFinite(eta) && distance > 0) continue
    out.push({ trainId: t.trainId, symbol: t.symbol, etaMinutes: Math.round(eta * 10) / 10, distanceMiles: Math.round(distance * 10) / 10, direction: t.direction })
  }
  return out.sort((a, b) => a.etaMinutes - b.etaMinutes || a.distanceMiles - b.distanceMiles)
}

const plusSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000).toISOString()

export function reconcile(s: HazardState | null, ctx: ReconcileContext): DomainEventDraft[] {
  if (!s) return []
  const by = ctx.actor ?? 'alerting'
  const out: DomainEventDraft[] = []

  if (!s.open) {
    const reason = s.responseStatus === 'false_alarm' ? 'hazard confirmed a false alarm' : 'hazard cleared'
    for (const r of activeRestrictions(s)) out.push(draft('SpeedRestrictionLifted', { hazardId: s.hazardId, restrictionId: r.restrictionId, reason, by }))
    const warned = activeWarnings(s)
    if (warned.length) out.push(draft('TrainsReleased', { hazardId: s.hazardId, trainIds: warned.map((t) => t.trainId), reason, by }))
    return out
  }

  if (s.detectionStatus === 'risk_subsided') {
    for (const r of activeRestrictions(s).filter((x) => x.automatic)) out.push(draft('SpeedRestrictionLifted', { hazardId: s.hazardId, restrictionId: r.restrictionId, reason: 'rail temperature back below the watch band', by }))
    out.push(draft('HazardCleared', { hazardId: s.hazardId, by, note: 'Rail temperature back below the watch band; standing heat order lifted.' }))
    return out
  }

  // Alerting: issue once, re-issue on worse severity, escalate on a missed deadline.
  if (!s.alert) {
    if (severityRank(s.severity) >= severityRank('MEDIUM')) {
      out.push(
        draft('AlertIssued', {
          hazardId: s.hazardId,
          alertId: `AL-${s.code.replace(/^HZ-/, '')}`,
          severity: s.severity,
          deskId: ctx.deskId,
          assignee: ctx.assignee,
          ackDeadlineAt: plusSeconds(ctx.now, ctx.cfg.ackSeconds[s.severity]),
          summary: summaryOf(s),
          lane: s.trigger.lane,
          late: s.trigger.late,
          timing: { edgeOccurredAt: s.trigger.occurredAt, ingestedAt: s.trigger.recordedAt, detectedAt: s.detectedAt },
        }),
      )
    }
  } else if (severityRank(s.severity) > severityRank(s.alert.severity)) {
    out.push(
      draft('AlertEscalated', {
        hazardId: s.hazardId,
        alertId: s.alert.alertId,
        level: s.alert.escalationLevel,
        reason: 'severity_raised',
        target: s.alert.escalationTarget ?? ctx.assignee ?? ESCALATION_TARGETS[0],
        severity: s.severity,
        ackDeadlineAt: plusSeconds(ctx.now, ctx.cfg.ackSeconds[s.severity]),
      }),
    )
  } else if (!s.alert.acknowledgedAt && ctx.now.getTime() >= Date.parse(s.alert.ackDeadlineAt) && s.alert.escalationLevel < ctx.cfg.maxEscalationLevel) {
    const level = s.alert.escalationLevel + 1
    out.push(
      draft('AlertEscalated', {
        hazardId: s.hazardId,
        alertId: s.alert.alertId,
        level,
        reason: 'ack_overdue',
        target: ESCALATION_TARGETS[level],
        severity: s.alert.severity,
        ackDeadlineAt: plusSeconds(ctx.now, ctx.cfg.ackSeconds[s.alert.severity]),
      }),
    )
  }

  // CRITICAL hazards: warn every approaching train not already warned, nearest first.
  if (s.severity === 'CRITICAL') {
    const warned = new Set(activeWarnings(s).map((t) => t.trainId))
    const fresh = approachingTrains(s, ctx.trains, ctx.cfg).filter((t) => !warned.has(t.trainId))
    if (fresh.length) {
      const stopAt = fresh[0].direction === 'increasing' ? s.mpFrom - 0.5 : s.mpTo + 0.5
      out.push(draft('TrainsWarned', { hazardId: s.hazardId, trains: fresh, instruction: `Stop short of MP ${stopAt.toFixed(1)}; ${summaryOf(s)}`, automatic: true, by }))
    }
  }

  // Heat risk: a standing heat order (illustrative policy) puts an automatic slow order on the segment.
  if (s.kind === 'rail_buckling_risk' && s.heat && (s.heat.band === 'elevated' || s.heat.band === 'critical')) {
    const speed = s.heat.band === 'critical' ? ctx.heat.criticalSpeedMph : ctx.heat.elevatedSpeedMph
    if (!activeRestrictions(s).some((r) => r.maxSpeedMph <= speed)) {
      out.push(
        draft('SpeedRestrictionIssued', {
          hazardId: s.hazardId,
          restrictionId: `SR-${randomUUID().slice(0, 8).toUpperCase()}`,
          subdivisionId: s.subdivisionId,
          mpFrom: s.mpFrom,
          mpTo: s.mpTo,
          maxSpeedMph: speed,
          reason: `Heat: rail ${s.heat.railTempF}°F, projected ${s.heat.projectedTempF}°F vs RNT ${s.heat.neutralTempF}°F (${s.heat.band})`,
          automatic: true,
          by,
        }),
      )
    }
  }
  return out
}

/** When the ack-deadline timer should next fire, or null when none should be pending. */
export function desiredTimer(s: HazardState | null, maxLevel: number): string | null {
  if (!s || !s.open || !s.alert || s.alert.acknowledgedAt) return null
  if (s.alert.escalationLevel >= maxLevel) return null
  return s.alert.ackDeadlineAt
}
