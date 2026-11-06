/**
 * Turns scored candidates into case decisions inside the analyzer's
 * transaction. For each bearing (or car, for brakes): open a case (AlertRaised),
 * escalate it in place (AlertEscalated), place the hold and open the work order
 * at MEDIUM and above, and request notifications. Cases are loaded by folding
 * their streams, decided with the pure deciders in domain/case.ts, and staged
 * with their loaded version as the expected version, so a concurrent
 * acknowledgment or handoff makes this transaction retry against the new state.
 *
 * Handoffs and hold moves as the train travels, acknowledgment deadlines and
 * escalation up the chain belong to the ack process manager (workers), not here:
 * the analyzer decides on evidence, the process manager on time and position.
 * @module analyzer/alert-manager
 */
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { actionFor, isBrakeKind, type AlertKind } from '../shared/domain.js'
import type { LiveEvent } from '../shared/events.js'
import { YARDS } from '../shared/network.js'
import type { EventBatch } from '../events/store.js'
import { decideClose, decideEscalate, decideNotify, decideOpenWorkOrder, decidePlaceHold, decideRaise, initialCase, type CaseEvent, type CaseState } from '../domain/case.js'
import { loadCases, openCaseIds, stageCase, syncCaseIndex } from '../domain/repository.js'
import { needsHold, planAlertChange } from './alert-plan.js'
import { ackDeadline, escalationLabel, ownerFor } from './ownership.js'
import { tierName, type Score } from './risk.js'
import { routeAlert, type RouteDecision, type TripState } from './routing.js'
import type { BearingFeatures } from './trend.js'

export interface Candidate {
  carId: string
  kind: AlertKind
  position: string
  score: Score
  features: BearingFeatures
}

export interface CaseContext {
  client: pg.PoolClient
  batch: EventBatch
  tripId: string
  symbol: string
  trip: TripState
  nowMs: number
  /** The pass whose processing caused this change: its lag decides whether the alert is "late". */
  triggerPass: { detectorId: string; passId: string; passedAt: Date; lagSeconds: number; milepost: number }
  lateAfterMinutes: number
  ownerByCar: Map<string, string>
}

export interface Transition {
  transition: 'opened' | 'escalated'
  tier: number
  late: boolean
}

export const alertKey = (carId: string, kind: string, position: string) => `${carId}|${kind}|${position}`

export const featureJson = (f: BearingFeatures) => ({
  observations: f.observations,
  aboveAmbient: Math.round(f.aboveAmbient),
  sideDelta: Math.round(f.sideDelta),
  maxSideDelta: Math.round(f.maxSideDelta),
  medianSideDelta: Math.round(f.medianSideDelta),
  risePer15mi: f.risePer15mi === null ? null : Math.round(f.risePer15mi * 10) / 10,
  consecutiveElevated: f.consecutiveElevated,
  percentile: Math.round(f.percentile * 10) / 10,
  maxGapMiles: Math.round(f.maxGapMiles),
  coverageGap: f.coverageGap,
  biasCorrected: f.biasCorrected,
  historyElevatedTrips: f.historyElevatedTrips,
  wheelDelta: Math.round(f.wheelDelta),
  wheelConsecutiveHot: f.wheelConsecutiveHot,
  brakingZoneReadings: f.brakingZoneReadings,
  coldWheelReadings: f.coldWheelReadings,
  edgeAlarm: f.edgeAlarm,
  lastDetectorId: f.lastDetectorId,
  lastMilepost: f.lastMilepost,
})

export const kindLabel = (kind: string) => (kind === 'hot_wheel' ? 'hot wheels (brake)' : kind === 'cold_wheel' ? 'cold wheels (brake)' : 'hot bearing')

function notifications(ctx: CaseContext, s: CaseState, c: Candidate, tier: number, route: RouteDecision, kind: string) {
  const label = `${tierName(tier)} ${kindLabel(c.kind)} ${c.carId}${isBrakeKind(c.kind) ? '' : ` ${c.position}`} on ${ctx.symbol}`
  const rows: Array<[string, string]> = []
  if (route.routing === 'dispatcher_and_yard' && route.deskId) rows.push(['dispatcher', route.deskId])
  const holdYard = s.yardId ?? route.yardId
  if (holdYard && needsHold(tier)) rows.push(['yard', holdYard])
  const owner = ctx.ownerByCar.get(c.carId)
  if (owner) rows.push(['car_owner', owner])
  if (tier === 4) rows.push(['reliability', 'reliability-desk'])
  const at = new Date(ctx.nowMs)
  return rows.flatMap(([channel, target]) => decideNotify(s, { channel, target, kind: kind === 'opened' ? 'opened' : `escalated:${tierName(tier)}`, message: `${label}. ${route.note}`, at }))
}

export async function applyCandidates(ctx: CaseContext, candidates: Candidate[]): Promise<{ notices: LiveEvent[]; transitions: Transition[]; existing: CaseState[] }> {
  const existing = (await loadCases(ctx.client, await openCaseIds(ctx.client, { tripId: ctx.tripId }))).filter((s) => s.caseType === 'alert')
  const byKey = new Map(existing.map((s) => [alertKey(s.carId!, s.kind!, s.position!), s]))
  const notices: LiveEvent[] = []
  const transitions: Transition[] = []
  const at = new Date(ctx.nowMs)
  const tp = ctx.triggerPass
  const trigger = { detectorId: tp.detectorId, passId: tp.passId, passedAt: tp.passedAt.toISOString(), lagSeconds: tp.lagSeconds }

  for (const c of candidates) {
    const current = byKey.get(alertKey(c.carId, c.kind, c.position)) ?? null
    const plan = planAlertChange(current ? { tier: current.tier, status: current.status } : null, c.score.tier)
    // 'refresh' is telemetry: BearingTrendUpdated carries it; the case only records decisions.
    if (plan.action === 'none' || plan.action === 'refresh') continue

    const route = routeAlert({ tier: plan.tier, lagSeconds: tp.lagSeconds, lateAfterMinutes: ctx.lateAfterMinutes, trip: ctx.trip, nowMs: ctx.nowMs, yards: YARDS, readingMilepost: c.features.lastMilepost })
    const owner = ownerFor(route.routing, route.deskId, route.yardId, ctx.ownerByCar.get(c.carId) ?? null)
    const due = ackDeadline(plan.tier, owner.role, ctx.nowMs)
    const ownerText = owner.role === 'owner' ? 'Car owner notified (no acknowledgment needed).' : `Owner: ${escalationLabel(owner.role, 0)} ${owner.id}${due ? `, acknowledge by ${due.toISOString().slice(11, 16)}Z` : ''}.`
    const common = {
      tier: plan.tier, action: actionFor(c.kind, plan.tier), routing: route.routing, deskId: route.deskId, territoryId: route.territoryId, yardId: route.yardId,
      owner, ackDueAt: due, reasons: c.score.reasons, features: featureJson(c.features), routeNote: `${route.note} ${ownerText}`, trigger, late: route.late, at,
    }
    let state: CaseState
    if (plan.action === 'open') {
      state = initialCase(randomUUID())
      state = stageCase(ctx.batch, state, decideRaise(state, {
        ...common, tripId: ctx.tripId, symbol: ctx.symbol, carId: c.carId, ownerMark: ctx.ownerByCar.get(c.carId) ?? null, kind: c.kind, position: c.position,
      }))
    } else {
      state = stageCase(ctx.batch, current!, decideEscalate(current!, { ...common, reopened: plan.reopen }))
    }
    // The hold, work order and notifications are consequences of the decision: caused by it.
    const decisionId = state.lastEventId
    const causedByDecision = (events: CaseEvent[]) => events.map((e) => ({ ...e, causationId: decisionId }))
    if (needsHold(plan.tier)) {
      const holdYard = state.yardId
      if (holdYard) {
        const reason = `${tierName(plan.tier)} ${kindLabel(c.kind)} alert${isBrakeKind(c.kind) ? '' : ` at ${c.position}`}: inspect before building into an outbound train`
        state = stageCase(ctx.batch, state, causedByDecision(decidePlaceHold(state, holdYard, reason, at)))
        state = stageCase(ctx.batch, state, causedByDecision(decideOpenWorkOrder(state, { caseType: 'alert', tripId: ctx.tripId, carId: c.carId, position: c.position, kind: c.kind, yardId: holdYard, priority: plan.tier, at })))
      }
    }
    const kind = plan.action === 'open' ? 'opened' : 'escalated'
    state = stageCase(ctx.batch, state, causedByDecision(notifications(ctx, state, c, plan.tier, route, kind)))
    await syncCaseIndex(ctx.client, state)
    byKey.set(alertKey(c.carId, c.kind, c.position), state)
    transitions.push({ transition: kind, tier: plan.tier, late: route.late })
    notices.push({ type: plan.action === 'open' ? 'alert.opened' : 'alert.escalated', alertId: state.caseId, tripId: ctx.tripId, carId: c.carId, tier: plan.tier, deskId: route.deskId, yardId: state.yardId, late: route.late })
  }
  return { notices, transitions, existing: [...byKey.values()] }
}

/**
 * Open alert cases left without evidence: either the bearing was mis-identified
 * before an AEI correction, or every reading behind it was taken on a wheelset
 * that has since been replaced. Close them, saying which.
 */
export async function closeOrphans(ctx: CaseContext, cases: CaseState[], observedKeys: Set<string>, replacedKeys: Set<string>): Promise<LiveEvent[]> {
  const notices: LiveEvent[] = []
  const at = new Date(ctx.nowMs)
  for (const s of cases) {
    if (s.status === 'inspected' || s.status === 'closed' || observedKeys.has(alertKey(s.carId!, s.kind!, s.position!))) continue
    const replaced = replacedKeys.has(`${s.carId}|${s.position}`) || (isBrakeKind(s.kind!) && [...replacedKeys].some((k) => k.startsWith(`${s.carId}|`)))
    const events = decideClose(s, {
      reason: replaced ? 'component_replaced' : 'identity_corrected',
      outcome: replaced ? 'component_replaced' : 'identity_corrected',
      note: replaced ? 'All evidence predates the wheelset now installed; kept as history of the old wheelset' : 'Bearing identity corrected by an AEI read; superseded',
      by: 'analyzer',
      at,
    })
    const after = stageCase(ctx.batch, s, events)
    await syncCaseIndex(ctx.client, after)
    notices.push({ type: 'alert.updated', alertId: s.caseId, tripId: ctx.tripId, yardId: s.yardId })
  }
  return notices
}
