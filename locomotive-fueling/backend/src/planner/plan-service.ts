/**
 * One planner run for one train:
 *  1. load inputs; widen the safety margin for stale or uncertain data,
 *  2. optimize within a time budget (fallback: greedy, then the last good plan),
 *  3. re-price the plan in force under the same inputs and decide with
 *     hysteresis; an accepted plan needs a bigger saving and only produces a
 *     proposal the fuel desk must confirm, unless it has become unsafe,
 *  4. persist a new immutable version (or a proposal, or just an evaluation),
 *  5. keep reservations and DTL orders in line: only accepted stops hold a pad
 *     slot or a truck.
 *
 * Concurrency: a per-train Valkey lock keeps two planners off the same train;
 * UNIQUE (train_id, version) and the one-current / one-proposed partial
 * indexes are the backstop if a lock ever expires mid-run.
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
import type { Slot } from './capacity.js'
import { decide, type HysteresisOutcome } from './hysteresis.js'
import { assembleInputs, stopKeyFor, type OrderLite } from './inputs.js'
import { greedy, optimize, simulate, stopSignature } from './optimizer.js'
import type { SimResult, StopSpec } from './types.js'

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

type Source = 'dp' | 'greedy_fallback' | 'last_good'

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

interface CurrentPlan {
  version: number
  lifecycle: 'recommended' | 'accepted'
  stops: { locationId: string; optionId: string; perUnit: { locomotiveId: string; targetGal: number }[] }[] | null
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
  const [{ rows: orderRows }, { rows: slotRows }, { rows: currentRows }] = await Promise.all([
    pool.query<OrderLite & { id: string; locationId: string; vendorOrderId: string | null }>(
      `SELECT id, stop_key AS "stopKey", option_id AS "optionId", location_id AS "locationId", status, attempts, vendor_order_id AS "vendorOrderId"
         FROM dtl_orders WHERE train_id = $1`,
      [trainId],
    ),
    pool.query<{ optionId: string; start: Date; end: Date }>(
      `SELECT option_id AS "optionId", slot_start AS start, slot_end AS "end" FROM stop_commitments
        WHERE state IN ('accepted', 'executing') AND train_id <> $1`,
      [trainId],
    ),
    pool.query<CurrentPlan>(
      `SELECT p.version, p.lifecycle,
              (SELECT json_agg(json_build_object('locationId', s.location_id, 'optionId', s.option_id, 'perUnit', s.per_unit) ORDER BY s.seq)
                 FROM plan_stops s WHERE s.plan_id = p.id) AS stops
         FROM fuel_plans p WHERE p.train_id = $1 AND p.is_current`,
      [trainId],
    ),
  ])
  const reservations = new Map<string, Slot[]>()
  for (const r of slotRows) reservations.set(r.optionId, [...(reservations.get(r.optionId) ?? []), { start: r.start.getTime(), end: r.end.getTime() }])

  const legs = buildLegs(train.path, tracks)
  const nowMs = now.getTime()
  const args = { train, legs, states, options, orders: orderRows, params, locations, nowMs, reservations }
  let assembled = assembleInputs(args)
  const current = currentRows[0]
  const accepted = current?.lifecycle === 'accepted'

  const aheadIds = () => new Set(assembled.inputs.points.map((p) => p.locationId))
  const incumbentStops = (): StopSpec[] | null =>
    current
      ? (current.stops ?? [])
          .filter((s) => aheadIds().has(s.locationId))
          .map((s) => ({ locationId: s.locationId, optionId: s.optionId, targets: Object.fromEntries(s.perUnit.map((u) => [u.locomotiveId, u.targetGal])) }))
      : null

  // ── Optimize within the time budget, with labelled fallbacks ──
  let source: Source = 'dp'
  let status: 'ok' | 'emergency' | 'infeasible' = 'ok'
  let result = optimize(assembled.inputs, { deadline: performance.now() + params.optimizerBudgetMs })
  let fallbackNote = ''
  if (result.timedOut) {
    const g = greedy(assembled.inputs)
    const inc = incumbentStops()
    if (g.feasible) {
      source = 'greedy_fallback'
      result = { feasible: true, stops: g.stops, objective: NaN }
      fallbackNote = `Optimizer exceeded its ${params.optimizerBudgetMs} ms budget; greedy plan used`
    } else if (inc && simulate(assembled.inputs, inc, 1 + assembled.inputs.params.safetyMarginPct).feasible) {
      source = 'last_good'
      result = { feasible: true, stops: inc, objective: NaN }
      fallbackNote = `Optimizer exceeded its ${params.optimizerBudgetMs} ms budget; last good plan kept`
    }
  }
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
  const inflate = 1 + inputs.params.safetyMarginPct

  // ── Decide ──
  const incStops = incumbentStops()
  const candidate = simulate(inputs, result.stops, inflate)
  // Costs are compared at the planning margin; safety of the plan in force is judged at a slightly
  // smaller margin, so a plan created on the p90 boundary isn't voided by the next small update.
  let incumbent: SimResult | null = null
  if (incStops) {
    const priced = simulate(inputs, incStops, inflate)
    const safety = simulate(inputs, incStops, 1 + Math.max(0, inputs.params.safetyMarginPct - params.safetyKeepSlackPct))
    incumbent = { ...priced, feasible: safety.feasible, breach: safety.breach, unavailable: safety.unavailable }
  }
  let outcome: HysteresisOutcome
  if (status === 'infeasible') {
    outcome = incStops
      ? { decision: 'keep_within_band', switched: false, savings: 0, threshold: 0, explanation: 'No plan reaches the destination even using reserve; the plan in force stays while the fuel desk intervenes' }
      : { decision: 'switch_unsafe', switched: true, savings: 0, threshold: 0, explanation: 'No feasible plan; fuel desk must arrange fuel' }
  } else if (source !== 'dp' && incumbent?.feasible) {
    outcome = { decision: 'keep_within_band', switched: false, savings: 0, threshold: 0, explanation: `${fallbackNote}; the plan in force is still safe, so it stays` }
  } else {
    outcome = decide(incumbent, candidate, params, { accepted })
    if (source !== 'dp') outcome = { ...outcome, explanation: `${fallbackNote}. ${outcome.explanation}` }
    if (status === 'emergency') outcome = { ...outcome, explanation: `Emergency (planning through reserve): ${outcome.explanation}` }
  }
  const chosen = outcome.switched ? result.stops : (incStops ?? [])
  const projection = simulate(inputs, chosen, 1)
  const greedyPlan = greedy(inputs)
  const greedySim = simulate(inputs, greedyPlan.stops, 1)
  const proposalSim = outcome.decision === 'propose_change' ? simulate(inputs, result.stops, 1) : null
  const reason = [trigger === 'initial' ? null : `${trigger.replace('_', ' ')}${detail ? ` (${detail})` : ''}`, outcome.explanation].filter(Boolean).join(': ')
  const confidence = assembled.confidence

  const resultingVersion = await withTransaction(async (db) => {
    const { rows: maxRows } = await db.query<{ v: number }>('SELECT COALESCE(max(version), 0) AS v FROM fuel_plans WHERE train_id = $1', [trainId])
    let version = current?.version ?? 0
    const writePlan = async (sim: SimResult, lifecycle: 'recommended' | 'proposed', isCurrent: boolean, v: number) => {
      const snapshot = {
        units: inputs.units.map((u) => ({ ...u, calibration: states.get(u.locomotiveId)?.calibration ?? 1 })),
        prices: Object.fromEntries(inputs.points.flatMap((p) => p.options.map((o) => [o.optionId, o.pricePerGal]))),
        unavailable: inputs.points.flatMap((p) => p.options.filter((o) => !o.available).map((o) => `${o.optionId}: ${o.unavailableReason}`)),
        queues: inputs.points.flatMap((p) => p.options.filter((o) => (o.queueMinutes ?? 0) > 0).map((o) => `${o.optionId}: ~${Math.round(o.queueMinutes!)} min wait for a bay`)),
        trainCalibration: assembled.trainCalibration,
        dataAgeHours: assembled.dataAgeHours,
        marginPct: inputs.params.safetyMarginPct,
        candidateObjective: candidate.cost.total,
        incumbentObjective: incumbent?.cost.total ?? null,
      }
      const plan = await db.query<{ id: string }>(
        `INSERT INTO fuel_plans (train_id, version, is_current, lifecycle, source, confidence, assumptions, status, trigger, reason, created_at, milepost,
                                 cost_total, cost_breakdown, greedy_cost, greedy_stops, inputs, profile, calibration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
        [
          trainId, v, isCurrent, lifecycle, source, confidence.confidence, JSON.stringify(confidence.assumptions), status, trigger, reason, now,
          assembled.currentMilepost, sim.cost.total, JSON.stringify(sim.cost), greedyPlan.feasible ? greedySim.cost.total : null, stopSignature(greedySim.stops),
          JSON.stringify(snapshot), JSON.stringify({ points: sim.profile, reserveGal: sim.reserveTotalGal, capacityGal: sim.capacityTotalGal }), assembled.trainCalibration,
        ],
      )
      for (const s of sim.stops) {
        await db.query(
          `INSERT INTO plan_stops (plan_id, seq, stop_key, location_id, option_id, kind, milepost, eta, gallons, per_unit, price_per_gal, fuel_cost, fee, delay_cost,
                                   dwell_minutes, queue_minutes, committed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [plan.rows[0].id, s.seq, stopKeyFor(trainId, s.locationId, s.optionId), s.locationId, s.optionId, s.kind, s.milepost, new Date(s.etaMs), s.gallons,
            JSON.stringify(s.perUnit), s.pricePerGal, s.fuelCost, s.fee, s.delayCost, s.dwellMinutes, s.queueMinutes, s.committed],
        )
      }
    }

    if (outcome.switched) {
      version = maxRows[0].v + 1
      await db.query(
        `UPDATE fuel_plans SET is_current = false, lifecycle = CASE WHEN lifecycle IN ('recommended', 'accepted', 'proposed') THEN 'superseded' ELSE lifecycle END
          WHERE train_id = $1 AND (is_current OR lifecycle = 'proposed')`,
        [trainId],
      )
      await writePlan(projection, 'recommended', true, version)
      // Reservations of stops the new plan drops are released; stops it keeps keep theirs until the new plan is accepted.
      const keep = projection.stops.map((s) => stopKeyFor(trainId, s.locationId, s.optionId))
      await db.query(
        `UPDATE stop_commitments SET state = 'cancelled', note = $3, updated_at = now() WHERE train_id = $1 AND state = 'accepted' AND NOT (stop_key = ANY($2))`,
        [trainId, keep, `Dropped by plan v${version}`],
      )
    } else if (outcome.decision === 'propose_change' && proposalSim) {
      // One pending proposal per train. The same stops again keep the existing one (and its version).
      const { rows: pending } = await db.query<{ signature: string | null }>(
        `SELECT (SELECT string_agg(s.option_id, ' → ' ORDER BY s.seq) FROM plan_stops s WHERE s.plan_id = p.id) AS signature
           FROM fuel_plans p WHERE p.train_id = $1 AND p.lifecycle = 'proposed'`,
        [trainId],
      )
      const same = pending[0] && (pending[0].signature ?? 'no stops') === stopSignature(proposalSim.stops)
      if (!same) {
        await db.query(`UPDATE fuel_plans SET lifecycle = 'superseded' WHERE train_id = $1 AND lifecycle = 'proposed'`, [trainId])
        await writePlan(proposalSim, 'proposed', false, maxRows[0].v + 1)
      }
    } else if (accepted) {
      // Still in force: move its reservations to the current ETAs.
      for (const s of projection.stops) {
        await db.query(
          `UPDATE stop_commitments SET slot_start = $2, slot_end = $3, expires_at = $4, updated_at = now() WHERE stop_key = $1 AND state = 'accepted'`,
          [stopKeyFor(trainId, s.locationId, s.optionId), new Date(s.etaMs), new Date(s.etaMs + s.dwellMinutes * 60_000), new Date(s.etaMs + s.dwellMinutes * 60_000 + params.reservationGraceHours * 3_600_000)],
        )
      }
    }
    await db.query(
      `INSERT INTO plan_evaluations (train_id, evaluated_at, trigger, trigger_detail, decision, current_version, resulting_version, incumbent_cost, candidate_cost,
                                     candidate_stops, explanation, projection, source, confidence, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        trainId, now, trigger, detail || null, outcome.decision, current?.version ?? null, version, incumbent?.cost.total ?? null, candidate.cost.total,
        stopSignature(candidate.stops), outcome.explanation,
        JSON.stringify({ points: projection.profile, reserveGal: projection.reserveTotalGal, capacityGal: projection.capacityTotalGal, cost: projection.cost, stops: projection.stops }),
        source, confidence.confidence, performance.now() - started,
      ],
    )
    return version
  })

  if (outcome.decision === 'switch_unsafe' && accepted) {
    await raiseAlert(
      { type: 'plan_voided', severity: 'critical', trainId, locomotiveId: null, dedupKey: `plan_voided:${trainId}:${resultingVersion}`, message: `${train.symbol}: accepted plan v${current!.version} is no longer safe or executable. ${outcome.explanation}` },
      now,
    )
  }
  if (outcome.decision === 'propose_change') {
    await raiseAlert(
      { type: 'plan_proposal', severity: 'info', trainId, locomotiveId: null, dedupKey: `plan_proposal:${trainId}`, message: `${train.symbol}: ${outcome.explanation}` },
      now,
    )
  }

  // The deviation band is measured from the processor's own train-level figure at the time of this evaluation.
  const measured = await redis.get(keys.trainCal(trainId))
  await redis.set(keys.trainPlanCal(trainId), measured ?? String(assembled.trainCalibration))
  await reconcileOrders(trainId, train.symbol, projection.stops, orderRows, resultingVersion, nowMs, params.orderWindowHours, inputs.points.map((p) => p.locationId))
  await publishEvent({ type: 'plan', trainId, id: resultingVersion, note: outcome.decision })
  logger.info({ trainId, trigger, decision: outcome.decision, version: resultingVersion, source, confidence: confidence.confidence, stops: stopSignature(projection.stops) }, 'planned')
  return outcome.decision
}

/**
 * Brings DTL orders in line with accepted stops: order trucks for accepted DTL
 * stops inside the ordering window (idempotent on the stop key), and ask to
 * cancel orders whose stop is no longer accepted. A recommendation alone never
 * orders a truck.
 */
async function reconcileOrders(
  trainId: string,
  symbol: string,
  stops: SimResult['stops'],
  orders: (OrderLite & { id: string; locationId: string; vendorOrderId: string | null })[],
  version: number,
  nowMs: number,
  windowHours: number,
  aheadLocations: string[],
): Promise<void> {
  const { rows } = await pool.query<{ stopKey: string }>(`SELECT stop_key AS "stopKey" FROM stop_commitments WHERE train_id = $1 AND state IN ('accepted', 'executing')`, [trainId])
  const committed = new Set(rows.map((r) => r.stopKey))
  for (const s of stops) {
    const key = stopKeyFor(trainId, s.locationId, s.optionId)
    if (s.kind !== 'dtl' || !committed.has(key)) continue
    if ((s.etaMs - nowMs) / 3_600_000 > windowHours) continue
    const res = await pool.query<{ id: string }>(
      `INSERT INTO dtl_orders (stop_key, train_id, location_id, option_id, plan_version, gallons_requested, per_unit, eta, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') ON CONFLICT (stop_key) DO NOTHING RETURNING id`,
      [key, trainId, s.locationId, s.optionId, version, Math.round(s.gallons), JSON.stringify(s.perUnit), new Date(s.etaMs)],
    )
    if (res.rowCount) {
      await pool.query(`INSERT INTO dtl_order_events (order_id, from_status, to_status, note) VALUES ($1, NULL, 'pending', $2)`, [
        res.rows[0].id,
        `Accepted stop needs ~${Math.round(s.gallons)} gal at ${s.name} (plan v${version})`,
      ])
      await publishEvent({ type: 'order', trainId, id: res.rows[0].id })
    }
  }
  const ahead = new Set(aheadLocations)
  for (const o of orders) {
    if (committed.has(o.stopKey) || !['pending', 'unknown', 'confirmed'].includes(o.status)) continue
    const passed = !ahead.has(o.locationId)
    const neverSent = o.status === 'pending' && o.attempts === 0
    const to = neverSent ? 'cancelled' : 'cancel_requested'
    const note = passed ? `Train passed ${o.locationId} without this delivery` : `Stop no longer accepted (plan v${version})`
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
