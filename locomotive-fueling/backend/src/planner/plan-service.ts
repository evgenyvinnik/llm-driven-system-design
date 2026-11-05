/**
 * One planner run for one train: load inputs, optimize, re-price the current
 * plan, decide with hysteresis, persist a new immutable version (or just an
 * evaluation row), then reconcile DTL orders with the plan in force.
 *
 * Concurrency: a per-train Valkey lock keeps two planners from working the same
 * train; UNIQUE (train_id, version) and the "one current plan" partial index
 * are the backstop if a lock ever expires mid-run.
 * @module planner/plan-service
 */
import { randomUUID } from 'node:crypto'
import { buildLegs } from '../domain/consumption.js'
import { raiseAlert, resolveAlert } from '../shared/alerts.js'
import { keys, redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { publishEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { planRuns } from '../shared/metrics.js'
import { loadFuelOptions, loadLocations, loadParams, loadTracks, loadTrain } from '../shared/repo.js'
import { simNow } from '../shared/sim-clock.js'
import { readStates } from '../shared/state.js'
import type { PlanTrigger } from '../shared/triggers.js'
import { decide } from './hysteresis.js'
import { assembleInputs, stopKeyFor, type OrderLite } from './inputs.js'
import { greedy, optimize, simulate, stopSignature } from './optimizer.js'
import type { StopSpec } from './types.js'

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

export async function planTrain(trainId: string, trigger: PlanTrigger, detail = ''): Promise<string> {
  const token = randomUUID()
  const got = await redis.set(keys.planLock(trainId), token, 'EX', config.planner.lockSeconds, 'NX')
  if (!got) {
    // Someone else is planning this train. Re-queue so the trigger isn't lost.
    await redis.xadd(keys.planRequests, '*', 'trainId', trainId, 'trigger', trigger, 'detail', detail)
    return 'locked'
  }
  const started = performance.now()
  try {
    const decision = await runPlanner(trainId, trigger, detail, started)
    planRuns.observe({ decision }, (performance.now() - started) / 1000)
    return decision
  } finally {
    await redis.eval(RELEASE, 1, keys.planLock(trainId), token)
  }
}

async function runPlanner(trainId: string, trigger: PlanTrigger, detail: string, started: number): Promise<string> {
  const train = await loadTrain(trainId)
  if (!train || train.status !== 'running') return 'skipped'
  const [tracks, options, params, locations, states, now] = await Promise.all([
    loadTracks(),
    loadFuelOptions(),
    loadParams(),
    loadLocations(),
    readStates(train.units.map((u) => u.locomotiveId)),
    simNow(),
  ])
  const { rows: orderRows } = await pool.query<OrderLite & { id: string; locationId: string; vendorOrderId: string | null }>(
    `SELECT id, stop_key AS "stopKey", option_id AS "optionId", location_id AS "locationId", status, attempts, vendor_order_id AS "vendorOrderId"
       FROM dtl_orders WHERE train_id = $1`,
    [trainId],
  )
  const legs = buildLegs(train.path, tracks)
  const nowMs = now.getTime()
  const args = { train, legs, states, options, orders: orderRows, params, locations, nowMs }
  let assembled = assembleInputs(args)
  const inflate = 1 + params.safetyMarginPct

  let status: 'ok' | 'emergency' | 'infeasible' = 'ok'
  let result = optimize(assembled.inputs)
  if (!result.feasible) {
    // Can't keep the reserve: plan the least-bad route through the reserve, and say so loudly.
    const emergency = assembleInputs({ ...args, zeroReserve: true })
    const second = optimize(emergency.inputs)
    status = second.feasible ? 'emergency' : 'infeasible'
    if (second.feasible) {
      assembled = emergency
      result = second
    }
    await raiseAlert(
      {
        type: 'plan_infeasible',
        severity: 'critical',
        trainId,
        locomotiveId: null,
        message: second.feasible
          ? `${train.symbol}: no plan keeps every unit above reserve (${result.reason ?? 'insufficient fuel'}). Emergency plan uses reserve; fuel at the first stop.`
          : `${train.symbol}: no plan reaches the destination even using reserve. Fuel desk must arrange fuel now.`,
      },
      now,
    )
  } else {
    await resolveAlert(`plan_infeasible:${trainId}`, now)
  }
  const { inputs } = assembled

  // The plan in force, restricted to stops still ahead.
  const { rows: currentRows } = await pool.query<{ version: number; stops: { locationId: string; optionId: string; perUnit: { locomotiveId: string; targetGal: number }[] }[] | null }>(
    `SELECT p.version,
            (SELECT json_agg(json_build_object('locationId', s.location_id, 'optionId', s.option_id, 'perUnit', s.per_unit) ORDER BY s.seq)
               FROM plan_stops s WHERE s.plan_id = p.id) AS stops
       FROM fuel_plans p WHERE p.train_id = $1 AND p.is_current`,
    [trainId],
  )
  const current = currentRows[0]
  const aheadIds = new Set(inputs.points.map((p) => p.locationId))
  const incumbentStops: StopSpec[] | null = current
    ? (current.stops ?? [])
        .filter((s) => aheadIds.has(s.locationId))
        .map((s) => ({ locationId: s.locationId, optionId: s.optionId, targets: Object.fromEntries(s.perUnit.map((u) => [u.locomotiveId, u.targetGal])) }))
    : null

  const candidate = simulate(inputs, result.stops, inflate)
  const incumbent = incumbentStops ? simulate(inputs, incumbentStops, inflate) : null
  const outcome = status === 'ok' ? decide(incumbent, candidate, params) : { decision: 'switch_unsafe' as const, switched: true, savings: 0, threshold: 0, explanation: `Emergency replan: ${result.reason ?? 'reserve cannot be kept'}` }
  const chosen = outcome.switched ? result.stops : incumbentStops!
  const projection = simulate(inputs, chosen, 1)
  const greedyPlan = greedy(inputs)
  const greedySim = simulate(inputs, greedyPlan.stops, 1)
  const reason = [trigger === 'initial' ? null : `${trigger.replace('_', ' ')}${detail ? ` (${detail})` : ''}`, outcome.explanation].filter(Boolean).join(': ')

  const resultingVersion = await withTransaction(async (db) => {
    let version = current?.version ?? 0
    if (outcome.switched) {
      version += 1
      await db.query('UPDATE fuel_plans SET is_current = false WHERE train_id = $1 AND is_current', [trainId])
      const snapshot = {
        units: inputs.units.map((u) => ({ ...u, calibration: states.get(u.locomotiveId)?.calibration ?? 1 })),
        prices: Object.fromEntries(inputs.points.flatMap((p) => p.options.map((o) => [o.optionId, o.pricePerGal]))),
        unavailable: inputs.points.flatMap((p) => p.options.filter((o) => !o.available).map((o) => `${o.optionId}: ${o.unavailableReason}`)),
        trainCalibration: assembled.trainCalibration,
        candidateObjective: candidate.cost.total,
        incumbentObjective: incumbent?.cost.total ?? null,
      }
      const plan = await db.query<{ id: string }>(
        `INSERT INTO fuel_plans (train_id, version, status, trigger, reason, created_at, milepost, cost_total, cost_breakdown, greedy_cost, greedy_stops, inputs, profile, calibration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [
          trainId, version, status, trigger, reason, now, assembled.currentMilepost, projection.cost.total, JSON.stringify(projection.cost),
          greedyPlan.feasible ? greedySim.cost.total : null, stopSignature(greedySim.stops), JSON.stringify(snapshot),
          JSON.stringify({ points: projection.profile, reserveGal: projection.reserveTotalGal, capacityGal: projection.capacityTotalGal }),
          assembled.trainCalibration,
        ],
      )
      for (const s of projection.stops) {
        await db.query(
          `INSERT INTO plan_stops (plan_id, seq, stop_key, location_id, option_id, kind, milepost, eta, gallons, per_unit, price_per_gal, fuel_cost, fee, delay_cost, dwell_minutes, committed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [plan.rows[0].id, s.seq, stopKeyFor(trainId, s.locationId, s.optionId), s.locationId, s.optionId, s.kind, s.milepost, new Date(s.etaMs), s.gallons,
            JSON.stringify(s.perUnit), s.pricePerGal, s.fuelCost, s.fee, s.delayCost, s.dwellMinutes, s.committed],
        )
      }
    }
    await db.query(
      `INSERT INTO plan_evaluations (train_id, evaluated_at, trigger, trigger_detail, decision, current_version, resulting_version, incumbent_cost, candidate_cost, candidate_stops, explanation, projection, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        trainId, now, trigger, detail || null, outcome.decision, current?.version ?? null, version, incumbent?.cost.total ?? null, candidate.cost.total,
        stopSignature(candidate.stops), outcome.explanation,
        JSON.stringify({ points: projection.profile, reserveGal: projection.reserveTotalGal, capacityGal: projection.capacityTotalGal, cost: projection.cost, stops: projection.stops }),
        performance.now() - started,
      ],
    )
    return version
  })

  // The deviation band is measured from the processor's own train-level figure at the time of this evaluation.
  const measured = await redis.get(keys.trainCal(trainId))
  await redis.set(keys.trainPlanCal(trainId), measured ?? String(assembled.trainCalibration))
  await reconcileOrders(trainId, train.symbol, projection.stops, orderRows, resultingVersion, nowMs, params.orderWindowHours, inputs.points.map((p) => p.locationId))
  await publishEvent({ type: 'plan', trainId, id: resultingVersion, note: outcome.decision })
  logger.info({ trainId, trigger, decision: outcome.decision, version: resultingVersion, stops: stopSignature(projection.stops) }, 'planned')
  return outcome.decision
}

/**
 * Brings DTL orders in line with the plan in force: order trucks for DTL stops
 * inside the ordering window (idempotent on the stop key), and ask to cancel
 * orders whose stop is no longer planned.
 */
async function reconcileOrders(
  trainId: string,
  symbol: string,
  stops: ReturnType<typeof simulate>['stops'],
  orders: (OrderLite & { id: string; locationId: string; vendorOrderId: string | null })[],
  version: number,
  nowMs: number,
  windowHours: number,
  aheadLocations: string[],
): Promise<void> {
  const planned = new Set(stops.map((s) => stopKeyFor(trainId, s.locationId, s.optionId)))
  for (const s of stops) {
    if (s.kind !== 'dtl') continue
    if ((s.etaMs - nowMs) / 3_600_000 > windowHours) continue
    const res = await pool.query<{ id: string }>(
      `INSERT INTO dtl_orders (stop_key, train_id, location_id, option_id, plan_version, gallons_requested, per_unit, eta, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') ON CONFLICT (stop_key) DO NOTHING RETURNING id`,
      [stopKeyFor(trainId, s.locationId, s.optionId), trainId, s.locationId, s.optionId, version, Math.round(s.gallons), JSON.stringify(s.perUnit), new Date(s.etaMs)],
    )
    if (res.rowCount) {
      await pool.query(`INSERT INTO dtl_order_events (order_id, from_status, to_status, note) VALUES ($1, NULL, 'pending', $2)`, [
        res.rows[0].id,
        `Plan v${version} needs ~${Math.round(s.gallons)} gal at ${s.name}`,
      ])
      await publishEvent({ type: 'order', trainId, id: res.rows[0].id })
    }
  }
  const ahead = new Set(aheadLocations)
  for (const o of orders) {
    if (planned.has(o.stopKey) || !['pending', 'unknown', 'confirmed'].includes(o.status)) continue
    const passed = !ahead.has(o.locationId)
    const neverSent = o.status === 'pending' && o.attempts === 0
    const to = neverSent ? 'cancelled' : 'cancel_requested'
    const note = passed ? `Train passed ${o.locationId} without this delivery` : `Plan v${version} no longer stops here`
    const res = await pool.query(`UPDATE dtl_orders SET status = $2, next_attempt_at = now(), updated_at = now() WHERE id = $1 AND status = $3`, [o.id, to, o.status])
    if (!res.rowCount) continue
    await pool.query(`INSERT INTO dtl_order_events (order_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)`, [o.id, o.status, to, note])
    if (passed && o.status === 'confirmed') {
      await raiseAlert(
        { type: 'missed_stop', severity: 'warning', trainId, locomotiveId: null, dedupKey: `missed_stop:${o.stopKey}`, message: `${symbol} passed ${o.locationId} without its DTL delivery; order is being cancelled.` },
        new Date(nowMs),
      )
    }
    await publishEvent({ type: 'order', trainId, id: o.id })
  }
}
