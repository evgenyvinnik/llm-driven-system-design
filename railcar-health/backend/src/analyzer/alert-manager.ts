/**
 * Applies alert plans inside the analyzer's transaction: open or escalate the
 * one alert per bearing per trip, place the car hold and work order at MEDIUM
 * and above, and write notification outbox rows. Everything here is keyed so a
 * redelivered pass cannot create a second alert, hold, work order or message.
 * @module analyzer/alert-manager
 */
import type pg from 'pg'
import { TIER_ACTION, type AlertKind } from '../shared/domain.js'
import type { LiveEvent } from '../shared/events.js'
import { YARDS } from '../shared/network.js'
import { needsHold, planAlertChange } from './alert-plan.js'
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
  status: 'open' | 'acknowledged'
  yard_id: string | null
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
  edgeAlarm: f.edgeAlarm,
  lastDetectorId: f.lastDetectorId,
  lastMilepost: f.lastMilepost,
})

async function notify(ctx: AlertContext, alertId: string, c: Candidate, tier: number, route: RouteDecision, kind: string): Promise<void> {
  const label = `${tierName(tier)} ${c.kind === 'hot_wheel' ? 'hot wheel' : 'hot bearing'} ${c.carId} ${c.position} on ${ctx.symbol}`
  const at = new Date(ctx.nowMs)
  const rows: Array<[string, string]> = []
  if (route.routing === 'dispatcher_and_yard' && route.deskId) rows.push(['dispatcher', route.deskId])
  if (route.yardId && needsHold(tier)) rows.push(['yard', route.yardId])
  const owner = ctx.ownerByCar.get(c.carId)
  if (owner) rows.push(['car_owner', owner])
  if (tier === 4) rows.push(['reliability', 'reliability-desk'])
  for (const [channel, target] of rows) {
    await ctx.client.query(
      `INSERT INTO notifications (alert_id, channel, target, kind, message, dedupe_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedupe_key) DO NOTHING`,
      [alertId, channel, target, kind, `${label}. ${route.note}`, `${alertId}:${channel}:${tier}`, at],
    )
  }
}

async function ensureHold(ctx: AlertContext, alertId: string, c: Candidate, tier: number, yardId: string | null): Promise<void> {
  if (!needsHold(tier) || !yardId) return
  const at = new Date(ctx.nowMs)
  await ctx.client.query(
    `INSERT INTO car_holds (car_id, alert_id, yard_id, reason, created_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (alert_id) DO NOTHING`,
    [c.carId, alertId, yardId, `${tierName(tier)} ${c.kind} alert at ${c.position}: inspect before building into an outbound train`, at],
  )
  await ctx.client.query(
    `INSERT INTO work_orders (alert_id, car_id, position, kind, yard_id, priority, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (alert_id) DO UPDATE SET priority = GREATEST(work_orders.priority, EXCLUDED.priority)`,
    [alertId, c.carId, c.position, c.kind, yardId, tier, at],
  )
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
      await ctx.client.query(
        `UPDATE alerts SET features = $2, reasons = COALESCE($3::jsonb, reasons), updated_at = $4 WHERE id = $1`,
        [current!.id, features, reasons, at],
      )
      const moved = await rerouteIfPassed(ctx, current!, c)
      if (moved) events.push(moved)
      continue
    }

    const route = routeAlert({
      tier: plan.tier,
      lagSeconds: tp.lagSeconds,
      lateAfterMinutes: ctx.lateAfterMinutes,
      trip: ctx.trip,
      nowMs: ctx.nowMs,
      yards: YARDS,
      readingMilepost: c.features.lastMilepost,
    })
    let alertId: string
    if (plan.action === 'open') {
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO alerts (trip_id, car_id, kind, position, tier, action, routing, desk_id, territory_id, yard_id, reasons, features,
                             route_note, trigger_detector_id, trigger_pass_id, trigger_passed_at, data_lag_seconds, late, opened_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
         RETURNING id`,
        [ctx.tripId, c.carId, c.kind, c.position, plan.tier, TIER_ACTION[plan.tier], route.routing, route.deskId, route.territoryId, route.yardId,
          JSON.stringify(c.score.reasons), features, route.note, tp.detectorId, tp.passId, tp.passedAt, tp.lagSeconds, route.late, at],
      )
      alertId = rows[0].id
    } else {
      alertId = current!.id
      await ctx.client.query(
        `UPDATE alerts SET tier = $2, action = $3, routing = $4, desk_id = $5, territory_id = $6, yard_id = COALESCE(yard_id, $7),
                reasons = $8, features = $9, route_note = $10, trigger_detector_id = $11, trigger_pass_id = $12, trigger_passed_at = $13,
                data_lag_seconds = $14, late = $15, escalated_at = $16, updated_at = $16,
                status = CASE WHEN $17 THEN 'open' ELSE status END, version = version + 1
          WHERE id = $1`,
        [alertId, plan.tier, TIER_ACTION[plan.tier], route.routing, route.deskId, route.territoryId, route.yardId, JSON.stringify(c.score.reasons),
          features, route.note, tp.detectorId, tp.passId, tp.passedAt, tp.lagSeconds, route.late, at, plan.reopen],
      )
    }
    const kind = plan.action === 'open' ? 'opened' : 'escalated'
    await ctx.client.query(
      `INSERT INTO alert_events (alert_id, kind, tier, detector_id, pass_id, note, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [alertId, kind, plan.tier, tp.detectorId, tp.passId, route.note, at],
    )
    if (current) {
      current.tier = plan.tier
      const moved = await rerouteIfPassed(ctx, current, c)
      if (moved) current.yard_id = moved.yardId ?? current.yard_id
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
 * A car held for inspection at a yard the train has now gone past (the yard
 * missed it, or the train didn't stop) is re-pointed at the next yard, with a
 * timeline entry saying so, instead of leaving a work order nobody can do.
 */
async function rerouteIfPassed(ctx: AlertContext, current: ExistingRow, c: Candidate): Promise<LiveEvent | null> {
  if (!needsHold(current.tier) || !ctx.nextYardId || !current.yard_id || current.yard_id === ctx.nextYardId || ctx.trip.status !== 'en_route') return null
  const open = await ctx.client.query(`SELECT 1 FROM work_orders WHERE alert_id = $1 AND status IN ('open', 'in_progress')`, [current.id])
  if (open.rowCount === 0) return null
  const at = new Date(ctx.nowMs)
  const note = `Car went past ${current.yard_id} uninspected; hold and work order moved to ${ctx.nextYardId}`
  await ctx.client.query(`UPDATE alerts SET yard_id = $2, route_note = $3, updated_at = $4 WHERE id = $1`, [current.id, ctx.nextYardId, note, at])
  await ctx.client.query(`UPDATE work_orders SET yard_id = $2, version = version + 1 WHERE alert_id = $1`, [current.id, ctx.nextYardId])
  await ctx.client.query(`UPDATE car_holds SET yard_id = $2 WHERE alert_id = $1 AND status = 'active'`, [current.id, ctx.nextYardId])
  await ctx.client.query(
    `INSERT INTO alert_events (alert_id, kind, tier, detector_id, pass_id, note, at) VALUES ($1, 'rerouted', $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [current.id, current.tier, ctx.triggerPass.detectorId, ctx.triggerPass.passId, note, at],
  )
  return { type: 'alert.updated', alertId: current.id, tripId: ctx.tripId, carId: c.carId, yardId: ctx.nextYardId }
}

/** Open alerts whose bearing no longer exists in this trip were pinned on the wrong position before an AEI correction. */
export async function closeOrphans(ctx: AlertContext, existing: ExistingRow[], observedKeys: Set<string>): Promise<LiveEvent[]> {
  const events: LiveEvent[] = []
  const at = new Date(ctx.nowMs)
  for (const e of existing) {
    if (observedKeys.has(alertKey(e.car_id, e.kind, e.position))) continue
    await ctx.client.query(`UPDATE alerts SET status = 'closed', outcome = 'identity_corrected', closed_at = $2, updated_at = $2, version = version + 1 WHERE id = $1`, [e.id, at])
    await ctx.client.query(`UPDATE car_holds SET status = 'released', released_at = $2, released_by = 'analyzer' WHERE alert_id = $1 AND status = 'active'`, [e.id, at])
    await ctx.client.query(`UPDATE work_orders SET status = 'cancelled', completed_at = $2 WHERE alert_id = $1 AND status <> 'completed'`, [e.id, at])
    await ctx.client.query(
      `INSERT INTO alert_events (alert_id, kind, note, at) VALUES ($1, 'closed', 'Bearing identity corrected by an AEI read; superseded', $2) ON CONFLICT DO NOTHING`,
      [e.id, at],
    )
    events.push({ type: 'alert.updated', alertId: e.id, tripId: ctx.tripId, yardId: e.yard_id })
  }
  return events
}
