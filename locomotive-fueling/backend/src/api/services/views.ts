/**
 * Read models for the UI: the fleet board and the train plan view. They join
 * PostgreSQL (trains, plans, orders, alerts) with the Valkey latest-state
 * store (positions and fuel). Access is enforced by the caller passing only
 * the train ids the user may see.
 * @module api/services/views
 */
import { buildLegs, nodeMileposts, reserveGallons } from '../../domain/consumption.js'
import { pool } from '../../shared/db.js'
import { loadFuelOptions, loadLocations, loadParams, loadTracks, loadTrains, type TrainRow } from '../../shared/repo.js'
import { readStates, type LocoState } from '../../shared/state.js'

export interface UnitView {
  locomotiveId: string
  model: string
  role: string
  capacityGal: number
  reserveGal: number
  fuelGal: number | null
  fuelRaw: number | null
  fuelPct: number | null
  notch: number | null
  engineState: string | null
  calibration: number
  sensorSuspect: boolean
  leakSuspect: boolean
}

export interface NextStopView {
  locationId: string
  name: string
  kind: string
  etaMs: number
  gallons: number
  orderStatus: string | null
}

export interface TrainSummary {
  id: string
  symbol: string
  routeId: string
  origin: string
  destination: string
  status: string
  plannedTons: number
  cars: number
  milepost: number
  totalMiles: number
  progressPct: number
  speedMph: number
  lastSeenMs: number | null
  nextLocation: { id: string; name: string; milepost: number } | null
  calibration: number
  units: UnitView[]
  plan: {
    version: number
    status: string
    lifecycle: string
    source: string
    confidence: string
    costTotal: number
    stops: number
    nextStop: NextStopView | null
    createdAt: string
    proposalVersion: number | null
    purchaseCost: number
  } | null
  alerts: { critical: number; warning: number }
}

function unitViews(train: TrainRow, states: Map<string, LocoState>, reservePct: number, reserveMinGal: number): UnitView[] {
  return train.units.map((u) => {
    const s = states.get(u.locomotiveId)
    return {
      locomotiveId: u.locomotiveId,
      model: u.model,
      role: u.role,
      capacityGal: u.tankGal,
      reserveGal: reserveGallons(u.tankGal, reservePct, reserveMinGal),
      fuelGal: s ? Math.round(s.fuelGal) : null,
      fuelRaw: s ? Math.round(s.fuelRaw) : null,
      fuelPct: s ? Math.round((s.fuelGal / u.tankGal) * 1000) / 10 : null,
      notch: s?.notch ?? null,
      engineState: s?.engineState ?? null,
      calibration: s ? Math.round(s.calibration * 1000) / 1000 : 1,
      sensorSuspect: s?.sensorSuspect ?? false,
      leakSuspect: s?.leakSuspect ?? false,
    }
  })
}

export async function fleetSummaries(trainIds: string[] | null, includeArrived = false): Promise<TrainSummary[]> {
  const [trains, tracks, locations, params] = await Promise.all([
    loadTrains(trainIds ? { ids: trainIds } : includeArrived ? {} : { status: 'running' }),
    loadTracks(),
    loadLocations(),
    loadParams(),
  ])
  const states = await readStates(trains.flatMap((t) => t.units.map((u) => u.locomotiveId)))
  const ids = trains.map((t) => t.id)
  const [plans, alerts] = await Promise.all([
    pool.query<{
      trainId: string
      version: number
      status: string
      lifecycle: string
      source: string
      confidence: string
      proposalVersion: number | null
      purchaseCost: number
      costTotal: number
      createdAt: string
      stops: NextStopView[] | null
    }>(
      `SELECT p.train_id AS "trainId", p.version, p.status, p.lifecycle, p.source, p.confidence, p.cost_total::float AS "costTotal", p.created_at AS "createdAt",
              (SELECT q.version FROM fuel_plans q WHERE q.train_id = p.train_id AND q.lifecycle = 'proposed') AS "proposalVersion",
              (SELECT COALESCE(sum(s.fuel_cost + s.fee), 0)::float FROM plan_stops s WHERE s.plan_id = p.id AND s.milepost >= p.milepost) AS "purchaseCost",
              (SELECT json_agg(json_build_object('locationId', s.location_id, 'name', l.name, 'kind', s.kind, 'etaMs', extract(epoch from s.eta) * 1000,
                       'gallons', round(s.gallons), 'orderStatus', o.status, 'milepost', s.milepost) ORDER BY s.seq)
                 FROM plan_stops s JOIN locations l ON l.id = s.location_id LEFT JOIN dtl_orders o ON o.stop_key = s.stop_key
                WHERE s.plan_id = p.id) AS stops
         FROM fuel_plans p WHERE p.is_current AND p.train_id = ANY($1)`,
      [ids],
    ),
    pool.query<{ trainId: string; severity: string; n: number }>(
      `SELECT train_id AS "trainId", severity, count(*)::int AS n FROM alerts WHERE status = 'open' AND train_id = ANY($1) GROUP BY 1, 2`,
      [ids],
    ),
  ])
  const planBy = new Map(plans.rows.map((p) => [p.trainId, p]))

  return trains.map((train) => {
    const legs = buildLegs(train.path, tracks)
    const nodes = nodeMileposts(legs)
    const totalMiles = legs.length ? legs[legs.length - 1].endMile : 0
    const lead = train.units.find((u) => u.role === 'lead') ?? train.units[0]
    const leadState = lead ? states.get(lead.locomotiveId) : undefined
    const milepost = train.status === 'arrived' ? totalMiles : Math.min(totalMiles, leadState?.milepost ?? train.lastMilepost)
    const next = nodes.find((n) => n.milepost > milepost + 0.05)
    const units = unitViews(train, states, params.reservePct, params.reserveMinGal)
    const healthy = units.filter((u) => !u.sensorSuspect && !u.leakSuspect)
    const plan = planBy.get(train.id)
    const stopsAhead = (plan?.stops ?? []).filter((s) => (s as NextStopView & { milepost: number }).milepost >= milepost - 0.5)
    return {
      id: train.id,
      symbol: train.symbol,
      routeId: train.routeId,
      origin: locations.get(train.path[0])?.name ?? train.path[0],
      destination: locations.get(train.path[train.path.length - 1])?.name ?? train.path[train.path.length - 1],
      status: train.status,
      plannedTons: train.plannedTons,
      cars: train.cars,
      milepost: Math.round(milepost * 10) / 10,
      totalMiles,
      progressPct: totalMiles ? Math.round((milepost / totalMiles) * 1000) / 10 : 0,
      speedMph: train.status === 'arrived' ? 0 : (leadState?.speedMph ?? 0),
      lastSeenMs: leadState?.recordedAt ?? null,
      nextLocation: next ? { id: next.locationId, name: locations.get(next.locationId)?.name ?? next.locationId, milepost: next.milepost } : null,
      calibration: healthy.length ? Math.round((healthy.reduce((s, u) => s + u.calibration, 0) / healthy.length) * 1000) / 1000 : 1,
      units,
      plan: plan
        ? {
            version: plan.version,
            status: plan.status,
            lifecycle: plan.lifecycle,
            source: plan.source,
            confidence: plan.confidence,
            proposalVersion: plan.proposalVersion,
            purchaseCost: plan.purchaseCost,
            costTotal: plan.costTotal,
            stops: stopsAhead.length,
            nextStop: stopsAhead[0] ? { ...stopsAhead[0], etaMs: Number(stopsAhead[0].etaMs) } : null,
            createdAt: plan.createdAt,
          }
        : null,
      alerts: {
        critical: alerts.rows.find((a) => a.trainId === train.id && a.severity === 'critical')?.n ?? 0,
        warning: alerts.rows.find((a) => a.trainId === train.id && a.severity === 'warning')?.n ?? 0,
      },
    }
  })
}

export async function trainDetail(trainId: string) {
  const [summary] = await fleetSummaries([trainId])
  if (!summary) return null
  const [train] = await loadTrains({ ids: [trainId] })
  const [tracks, locations, options] = await Promise.all([loadTracks(), loadLocations(), loadFuelOptions()])
  const nodes = nodeMileposts(buildLegs(train.path, tracks)).map((n) => ({
    locationId: n.locationId,
    name: locations.get(n.locationId)?.name ?? n.locationId,
    state: locations.get(n.locationId)?.state ?? '',
    milepost: n.milepost,
    fuel: options.filter((o) => o.locationId === n.locationId && o.active).map((o) => ({ optionId: o.id, kind: o.kind, pricePerGal: o.pricePerGal })),
  }))

  const [plan, versions, evaluations, orders, alerts, tickets] = await Promise.all([
    pool.query(
      `SELECT p.id, p.version, p.status, p.lifecycle, p.accepted_by AS "acceptedBy", p.accepted_at AS "acceptedAt", p.source, p.confidence, p.assumptions,
              p.trigger, p.reason, p.created_at AS "createdAt", p.milepost, p.cost_total::float AS "costTotal",
              p.cost_breakdown AS "costBreakdown", p.greedy_cost::float AS "greedyCost", p.greedy_stops AS "greedyStops", p.inputs, p.profile, p.calibration,
              COALESCE((SELECT json_agg(json_build_object(
                 'seq', s.seq, 'stopKey', s.stop_key, 'locationId', s.location_id, 'name', l.name, 'optionId', s.option_id, 'kind', s.kind,
                 'milepost', s.milepost, 'etaMs', extract(epoch from s.eta) * 1000, 'gallons', s.gallons, 'perUnit', s.per_unit,
                 'pricePerGal', s.price_per_gal::float, 'fuelCost', s.fuel_cost::float, 'fee', s.fee::float, 'delayCost', s.delay_cost::float,
                 'dwellMinutes', s.dwell_minutes, 'queueMinutes', s.queue_minutes, 'committed', s.committed, 'orderStatus', o.status, 'orderId', o.id,
                 'commitment', c.state, 'slotStart', c.slot_start, 'slotEnd', c.slot_end, 'expiresAt', c.expires_at) ORDER BY s.seq)
                 FROM plan_stops s JOIN locations l ON l.id = s.location_id LEFT JOIN dtl_orders o ON o.stop_key = s.stop_key
                 LEFT JOIN stop_commitments c ON c.stop_key = s.stop_key
                WHERE s.plan_id = p.id), '[]') AS stops
         FROM fuel_plans p WHERE p.train_id = $1 AND p.is_current`,
      [trainId],
    ),
    pool.query(
      `SELECT p.version, p.status, p.lifecycle, p.source, p.accepted_by AS "acceptedBy", p.trigger, p.reason, p.created_at AS "createdAt",
              p.cost_total::float AS "costTotal", p.milepost,
              COALESCE((SELECT string_agg(s.option_id, ' → ' ORDER BY s.seq) FROM plan_stops s WHERE s.plan_id = p.id), 'no stops') AS signature
         FROM fuel_plans p WHERE p.train_id = $1 ORDER BY p.version DESC LIMIT 30`,
      [trainId],
    ),
    pool.query(
      `SELECT id, evaluated_at AS "evaluatedAt", trigger, trigger_detail AS "triggerDetail", decision, current_version AS "currentVersion",
              resulting_version AS "resultingVersion", incumbent_cost::float AS "incumbentCost", candidate_cost::float AS "candidateCost",
              candidate_stops AS "candidateStops", explanation, source, confidence, duration_ms AS "durationMs"
         FROM plan_evaluations WHERE train_id = $1 ORDER BY id DESC LIMIT 20`,
      [trainId],
    ),
    pool.query(
      `SELECT o.id, o.stop_key AS "stopKey", o.location_id AS "locationId", l.name, o.status, o.gallons_requested AS "gallonsRequested",
              o.vendor_order_id AS "vendorOrderId", o.attempts, o.last_error AS "lastError", o.eta, o.updated_at AS "updatedAt"
         FROM dtl_orders o JOIN locations l ON l.id = o.location_id WHERE o.train_id = $1 ORDER BY o.id`,
      [trainId],
    ),
    pool.query(
      `SELECT id, type, severity, locomotive_id AS "locomotiveId", message, status, raised_at AS "raisedAt"
         FROM alerts WHERE train_id = $1 ORDER BY (status = 'open') DESC, id DESC LIMIT 20`,
      [trainId],
    ),
    pool.query(
      `SELECT id, source, location_id AS "locationId", gallons_total AS "gallonsTotal", status, telemetry_gallons AS "telemetryGallons",
              price_per_gal::float AS "pricePerGal", delivered_at AS "deliveredAt"
         FROM fuel_tickets WHERE train_id = $1 ORDER BY delivered_at`,
      [trainId],
    ),
  ])
  const proposal = await pool.query(
    `SELECT p.version, p.reason, p.cost_total::float AS "costTotal", p.cost_breakdown AS "costBreakdown", p.created_at AS "createdAt", p.profile,
            COALESCE((SELECT json_agg(json_build_object('seq', s.seq, 'name', l.name, 'optionId', s.option_id, 'kind', s.kind, 'gallons', s.gallons,
                       'etaMs', extract(epoch from s.eta) * 1000, 'fuelCost', s.fuel_cost::float) ORDER BY s.seq)
               FROM plan_stops s JOIN locations l ON l.id = s.location_id WHERE s.plan_id = p.id), '[]') AS stops
       FROM fuel_plans p WHERE p.train_id = $1 AND p.lifecycle = 'proposed'`,
    [trainId],
  )
  const latest = await pool.query(
    `SELECT evaluated_at AS "evaluatedAt", trigger, decision, explanation, projection FROM plan_evaluations WHERE train_id = $1 ORDER BY id DESC LIMIT 1`,
    [trainId],
  )
  return {
    train: { ...summary, path: nodes },
    plan: plan.rows[0] ?? null,
    proposal: proposal.rows[0] ?? null,
    projection: latest.rows[0] ?? null,
    versions: versions.rows,
    evaluations: evaluations.rows,
    orders: orders.rows,
    alerts: alerts.rows,
    tickets: tickets.rows,
  }
}
