/**
 * Applies alert plans inside the analyzer's transaction: open or escalate the
 * one alert per bearing (or per car, for brakes) per trip, assign its owner and
 * acknowledgment deadline, hand it off when the train moves to another desk or
 * yard, place the car hold and work order at MEDIUM and above, and write
 * notification outbox rows. Everything is keyed so a redelivered pass cannot
 * create a second alert, hold, work order or message.
 * @module analyzer/alert-manager
 */
import type pg from 'pg'
import { actionFor, isBrakeKind, type AlertKind } from '../shared/domain.js'
import type { LiveEvent } from '../shared/events.js'
import { YARDS } from '../shared/network.js'
import { needsHold, planAlertChange } from './alert-plan.js'
import { ackDeadline, escalationLabel, needsHandoff, ownerFor, type Owner, type OwnerRole } from './ownership.js'
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

export interface ExistingRow {
  id: string
  car_id: string
  kind: AlertKind
  position: string
  tier: number
  status: 'open' | 'acknowledged' | 'inspected'
  yard_id: string | null
  owner_role: OwnerRole | null
  owner_id: string | null
}

export interface AlertContext {
  client: pg.PoolClient
  tripId: string
  symbol: string
  trip: TripState
  nowMs: number
  /** The pass whose processing caused this change: its lag decides whether the alert is "late". */
  triggerPass: { detectorId: string; passId: string; passedAt: Date; lagSeconds: number; milepost: number }
  lateAfterMinutes: number
  ownerByCar: Map<string, string>
  /** The yard the train will reach next (null once it has arrived). */
  nextYardId: string | null
  /** The dispatcher desk whose territory the train is in now (null once it has arrived). */
  deskId: string | null
}

export interface Transition {
  transition: 'opened' | 'escalated'
  tier: number
  late: boolean
}

export const alertKey = (carId: string, kind: string, position: string) => `${carId}|${kind}|${position}`

const featureJson = (f: BearingFeatures) => ({
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

const kindLabel = (kind: string) => (kind === 'hot_wheel' ? 'hot wheels (brake)' : kind === 'cold_wheel' ? 'cold wheels (brake)' : 'hot bearing')

async function addNotification(ctx: AlertContext, alertId: string, channel: string, target: string, kind: string, message: string, dedupe: string): Promise<void> {
  await ctx.client.query(
    `INSERT INTO notifications (alert_id, channel, target, kind, message, dedupe_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedupe_key) DO NOTHING`,
    [alertId, channel, target, kind, message, dedupe, new Date(ctx.nowMs)],
  )
}

async function notify(ctx: AlertContext, alertId: string, c: Candidate, tier: number, route: RouteDecision, kind: string): Promise<void> {
  const label = `${tierName(tier)} ${kindLabel(c.kind)} ${c.carId}${isBrakeKind(c.kind) ? '' : ` ${c.position}`} on ${ctx.symbol}`
  const rows: Array<[string, string]> = []
  if (route.routing === 'dispatcher_and_yard' && route.deskId) rows.push(['dispatcher', route.deskId])
  if (route.yardId && needsHold(tier)) rows.push(['yard', route.yardId])
  const owner = ctx.ownerByCar.get(c.carId)
  if (owner) rows.push(['car_owner', owner])
  if (tier === 4) rows.push(['reliability', 'reliability-desk'])
  for (const [channel, target] of rows) await addNotification(ctx, alertId, channel, target, kind, `${label}. ${route.note}`, `${alertId}:${channel}:${tier}`)
}

async function audit(ctx: AlertContext, alertId: string, kind: string, tier: number | null, note: string): Promise<void> {
  await ctx.client.query(
    `INSERT INTO alert_events (alert_id, kind, tier, detector_id, pass_id, note, at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [alertId, kind, tier, ctx.triggerPass.detectorId, ctx.triggerPass.passId, note, new Date(ctx.nowMs)],
  )
}

async function ensureHold(ctx: AlertContext, alertId: string, c: Candidate, tier: number, yardId: string | null): Promise<void> {
  if (!needsHold(tier) || !yardId) return
  const at = new Date(ctx.nowMs)
  await ctx.client.query(
    `INSERT INTO car_holds (car_id, alert_id, yard_id, reason, created_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (alert_id) DO NOTHING`,
    [c.carId, alertId, yardId, `${tierName(tier)} ${kindLabel(c.kind)} alert${isBrakeKind(c.kind) ? '' : ` at ${c.position}`}: inspect before building into an outbound train`, at],
  )
  await ctx.client.query(
    `INSERT INTO work_orders (alert_id, trip_id, car_id, position, kind, yard_id, priority, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (alert_id) DO UPDATE SET priority = GREATEST(work_orders.priority, EXCLUDED.priority)`,
    [alertId, ctx.tripId, c.carId, c.position, c.kind, yardId, tier, at],
  )
}

/**
 * Ownership follows the train. A dispatcher-owned alert moves to the desk whose
 * territory the train entered; a yard-owned one moves to the next yard if the
 * train went past the yard that was meant to catch the car. Either way the new
 * owner must acknowledge again, and the move is written to the audit trail.
 */
async function handoffIfMoved(ctx: AlertContext, current: ExistingRow, c: Candidate): Promise<LiveEvent | null> {
  if (current.status === 'inspected' || !current.owner_role || ctx.trip.status !== 'en_route') return null
  // The car hold and work order follow the train to the next yard whoever owns the alert.
  const yardMoved = await repointYard(ctx, current, c)
  const was: Owner = { role: current.owner_role, id: current.owner_id }
  let next: Owner | null = null
  if (was.role === 'dispatcher') next = { role: 'dispatcher', id: ctx.deskId }
  if (was.role === 'yard' && yardMoved) next = { role: 'yard', id: ctx.nextYardId }
  if (!next || !needsHandoff(was, next)) {
    return yardMoved ? { type: 'alert.updated', alertId: current.id, tripId: ctx.tripId, carId: c.carId, yardId: current.yard_id } : null
  }
  const at = new Date(ctx.nowMs)
  const due = ackDeadline(current.tier, next.role, ctx.nowMs)
  const note =
    was.role === 'dispatcher'
      ? `Train left ${was.id} desk territory: ownership handed to ${next.id} desk, which must acknowledge`
      : `Car went past ${was.id} uninspected: hold and work order handed to ${next.id}, which must acknowledge`
  await ctx.client.query(
    `UPDATE alerts SET owner_id = $2, status = CASE WHEN status = 'acknowledged' THEN 'open' ELSE status END, ack_due_at = $3, escalation_level = 0,
            desk_id = CASE WHEN $4 = 'dispatcher' THEN $2 ELSE desk_id END, yard_id = CASE WHEN $4 = 'yard' THEN $2 ELSE yard_id END,
            route_note = $5, updated_at = $6, version = version + 1
      WHERE id = $1`,
    [current.id, next.id, due, was.role, note, at],
  )
  await audit(ctx, current.id, 'handoff', current.tier, note)
  await addNotification(ctx, current.id, was.role, next.id!, 'handoff', `${tierName(current.tier)} ${kindLabel(c.kind)} ${c.carId} on ${ctx.symbol}: ${note}`, `${current.id}:handoff:${next.id}`)
  current.owner_id = next.id
  if (was.role === 'yard') current.yard_id = next.id
  return { type: 'alert.updated', alertId: current.id, tripId: ctx.tripId, carId: c.carId, yardId: current.yard_id, deskId: was.role === 'dispatcher' ? next.id : null }
}

/** A car held for a yard the train has gone past (uninspected) is re-pointed at the next yard. */
async function repointYard(ctx: AlertContext, current: ExistingRow, c: Candidate): Promise<boolean> {
  if (!needsHold(current.tier) || !ctx.nextYardId || !current.yard_id || current.yard_id === ctx.nextYardId) return false
  const open = await ctx.client.query(`SELECT 1 FROM work_orders WHERE alert_id = $1 AND status IN ('open', 'in_progress')`, [current.id])
  if (open.rowCount === 0) return false
  const from = current.yard_id
  await ctx.client.query(`UPDATE alerts SET yard_id = $2, updated_at = $3 WHERE id = $1`, [current.id, ctx.nextYardId, new Date(ctx.nowMs)])
  await ctx.client.query(`UPDATE work_orders SET yard_id = $2, version = version + 1 WHERE alert_id = $1`, [current.id, ctx.nextYardId])
  await ctx.client.query(`UPDATE car_holds SET yard_id = $2 WHERE alert_id = $1 AND status = 'active'`, [current.id, ctx.nextYardId])
  if (current.owner_role !== 'yard') {
    await audit(ctx, current.id, 'rerouted', current.tier, `Car went past ${from} uninspected: hold and work order moved to ${ctx.nextYardId}`)
    await addNotification(ctx, current.id, 'yard', ctx.nextYardId, 'rerouted', `${tierName(current.tier)} ${kindLabel(c.kind)} ${c.carId} on ${ctx.symbol}: car held for inspection at ${ctx.nextYardId} (went past ${from})`, `${current.id}:reroute:${ctx.nextYardId}`)
  }
  current.yard_id = ctx.nextYardId
  return true
}

export async function applyCandidates(ctx: AlertContext, candidates: Candidate[], existing: ExistingRow[]): Promise<{ events: LiveEvent[]; transitions: Transition[] }> {
  const byKey = new Map(existing.map((e) => [alertKey(e.car_id, e.kind, e.position), e]))
  const events: LiveEvent[] = []
  const transitions: Transition[] = []
  const at = new Date(ctx.nowMs)
  const { triggerPass: tp } = ctx

  for (const c of candidates) {
    const current = byKey.get(alertKey(c.carId, c.kind, c.position)) ?? null
    const plan = planAlertChange(current, c.score.tier)
    if (plan.action === 'none') continue
    const features = featureJson(c.features)

    if (plan.action === 'refresh') {
      // Telemetry only: features move, the decision (tier, status, version) does not.
      const reasons = c.score.tier >= plan.tier ? JSON.stringify(c.score.reasons) : null
      await ctx.client.query(`UPDATE alerts SET features = $2, reasons = COALESCE($3::jsonb, reasons), updated_at = $4 WHERE id = $1`, [current!.id, features, reasons, at])
      const moved = await handoffIfMoved(ctx, current!, c)
      if (moved) events.push(moved)
      continue
    }

    const route = routeAlert({ tier: plan.tier, lagSeconds: tp.lagSeconds, lateAfterMinutes: ctx.lateAfterMinutes, trip: ctx.trip, nowMs: ctx.nowMs, yards: YARDS, readingMilepost: c.features.lastMilepost })
    const owner = ownerFor(route.routing, route.deskId, route.yardId, ctx.ownerByCar.get(c.carId) ?? null)
    const due = ackDeadline(plan.tier, owner.role, ctx.nowMs)
    let alertId: string
    if (plan.action === 'open') {
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO alerts (trip_id, car_id, kind, position, tier, action, routing, desk_id, territory_id, yard_id, reasons, features, route_note,
                             trigger_detector_id, trigger_pass_id, trigger_passed_at, data_lag_seconds, late, owner_role, owner_id, ack_due_at, opened_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22)
         RETURNING id`,
        [ctx.tripId, c.carId, c.kind, c.position, plan.tier, actionFor(c.kind, plan.tier), route.routing, route.deskId, route.territoryId, route.yardId,
          JSON.stringify(c.score.reasons), features, route.note, tp.detectorId, tp.passId, tp.passedAt, tp.lagSeconds, route.late, owner.role, owner.id, due, at],
      )
      alertId = rows[0].id
    } else {
      alertId = current!.id
      // A higher tier can change who owns the alert (a yard MEDIUM becomes a dispatcher HIGH); the owner must acknowledge the new tier.
      await ctx.client.query(
        `UPDATE alerts SET tier = $2, action = $3, routing = $4, desk_id = $5, territory_id = $6, yard_id = COALESCE(yard_id, $7),
                reasons = $8, features = $9, route_note = $10, trigger_detector_id = $11, trigger_pass_id = $12, trigger_passed_at = $13,
                data_lag_seconds = $14, late = $15, escalated_at = $16, updated_at = $16, owner_role = $18, owner_id = $19, ack_due_at = $20,
                escalation_level = 0, status = CASE WHEN $17 THEN 'open' ELSE status END, version = version + 1
          WHERE id = $1`,
        [alertId, plan.tier, actionFor(c.kind, plan.tier), route.routing, route.deskId, route.territoryId, route.yardId, JSON.stringify(c.score.reasons),
          features, route.note, tp.detectorId, tp.passId, tp.passedAt, tp.lagSeconds, route.late, at, plan.reopen, owner.role, owner.id, due],
      )
    }
    const kind = plan.action === 'open' ? 'opened' : 'escalated'
    const ownerText = owner.role === 'owner' ? 'Car owner notified (no acknowledgment needed).' : `Owner: ${escalationLabel(owner.role, 0)} ${owner.id}${due ? `, acknowledge by ${due.toISOString().slice(11, 16)}Z` : ''}.`
    await audit(ctx, alertId, kind, plan.tier, `${route.note} ${ownerText}`)
    if (current) {
      current.tier = plan.tier
      current.owner_role = owner.role
      current.owner_id = owner.id
      const moved = await handoffIfMoved(ctx, current, c)
      if (moved) events.push(moved)
    }
    const holdYard = current?.yard_id ?? route.yardId
    await ensureHold(ctx, alertId, c, plan.tier, holdYard)
    await notify(ctx, alertId, c, plan.tier, route, kind)
    transitions.push({ transition: kind, tier: plan.tier, late: route.late })
    events.push({ type: plan.action === 'open' ? 'alert.opened' : 'alert.escalated', alertId, tripId: ctx.tripId, carId: c.carId, tier: plan.tier, deskId: route.deskId, yardId: holdYard, late: route.late })
  }
  return { events, transitions }
}

/**
 * Open alerts left without evidence: either the bearing was mis-identified
 * before an AEI correction, or every reading behind it was taken on a wheelset
 * that has since been replaced. Close them, saying which.
 */
export async function closeOrphans(ctx: AlertContext, existing: ExistingRow[], observedKeys: Set<string>, replacedKeys: Set<string>): Promise<LiveEvent[]> {
  const events: LiveEvent[] = []
  const at = new Date(ctx.nowMs)
  for (const e of existing) {
    if (e.status === 'inspected' || observedKeys.has(alertKey(e.car_id, e.kind, e.position))) continue
    const replaced = replacedKeys.has(`${e.car_id}|${e.position}`) || (isBrakeKind(e.kind) && [...replacedKeys].some((k) => k.startsWith(`${e.car_id}|`)))
    const outcome = replaced ? 'component_replaced' : 'identity_corrected'
    const note = replaced ? 'All evidence predates the wheelset now installed; kept as history of the old wheelset' : 'Bearing identity corrected by an AEI read; superseded'
    await ctx.client.query(`UPDATE alerts SET status = 'closed', outcome = $2, closed_at = $3, updated_at = $3, version = version + 1 WHERE id = $1`, [e.id, outcome, at])
    await ctx.client.query(`UPDATE car_holds SET status = 'released', released_at = $2, released_by = 'analyzer' WHERE alert_id = $1 AND status = 'active'`, [e.id, at])
    await ctx.client.query(`UPDATE work_orders SET status = 'cancelled', completed_at = $2 WHERE alert_id = $1 AND status NOT IN ('completed', 'cancelled')`, [e.id, at])
    await audit(ctx, e.id, 'closed', null, note)
    events.push({ type: 'alert.updated', alertId: e.id, tripId: ctx.tripId, yardId: e.yard_id })
  }
  return events
}
