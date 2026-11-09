/**
 * The board, crew reports, alerts, track status, departure revisions, holds and
 * everything a machine integration calls.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireIntegrationToken, requireRole, requireRoleOrToken } from '../../shared/auth.js'
import { pool, withSnapshotRead, withTransaction } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { applyHoldEvent, holdEnvelope } from '../../holds/apply.js'
import { applyCrewReport, crewReportSchema } from '../../execution/reports.js'
import { advanceClock, recordArrival, recordDeparture, reviseDeparture, setTrackStatus, slipTrain } from '../../execution/yard-events.js'
import { shiftMetrics } from '../../metrics/shift.js'
import { buildBoard, buildCrewView } from '../../plans/board.js'
import { readYard } from '../../plans/state.js'
import { rollShift } from '../../plans/yard-load.js'

export const yardRouter = Router()
export const integrationsRouter = Router()

const iso = z.string().datetime({ offset: true })

yardRouter.get(
  '/yard/board',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(await withSnapshotRead((client) => buildBoard(client)))
  }),
)

yardRouter.get(
  '/yard/log',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT version, kind, detail, actor, sim_at FROM yard_state_log ORDER BY version DESC LIMIT 60`)
    res.json({ log: rows.map((r) => ({ version: Number(r.version), kind: r.kind, detail: r.detail, actor: r.actor, simAt: r.sim_at })) })
  }),
)

yardRouter.post(
  '/yard/tracks/:id/status',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const body = z.object({ open: z.boolean(), reason: z.string().trim().min(3).max(300) }).parse(req.body)
    const out = await withTransaction((client) => setTrackStatus(client, req.params.id, body.open, body.reason, req.user!.username))
    res.json(out)
  }),
)

yardRouter.post(
  '/yard/inbound/:id/eta',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const body = z.object({ eta: iso, reason: z.string().trim().min(3).max(300) }).parse(req.body)
    res.json(await withTransaction((client) => slipTrain(client, req.params.id, body.eta, req.user!.username, body.reason)))
  }),
)

/** Knowingly hold a train: an operating override. It changes the departure both planner and validator read. */
yardRouter.post(
  '/yard/outbound/:id/revise-departure',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const body = z.object({ departure: iso, reason: z.string().trim().min(3).max(500), reasonCode: z.string().min(1).max(40) }).parse(req.body)
    res.json(await withTransaction((client) => reviseDeparture(client, req.params.id, body.departure, req.user!.username, body.reason, body.reasonCode)))
  }),
)

// ── Alerts ──────────────────────────────────────────────────────────────

yardRouter.get(
  '/alerts',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 80`)
    res.json({ alerts: rows.map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, status: a.status, message: a.message, carId: a.car_id, outboundId: a.outbound_id, moveKey: a.move_key, simAt: a.sim_at, ackedBy: a.acked_by })) })
  }),
)

yardRouter.post(
  '/alerts/:id/ack',
  requireRole('yardmaster'),
  asyncHandler(async (req, res) => {
    const { rowCount } = await pool.query(`UPDATE alerts SET status = 'acknowledged', acked_by = $2, acked_at = now() WHERE id = $1 AND status = 'open'`, [req.params.id, req.user!.username])
    res.json({ acknowledged: (rowCount ?? 0) > 0 })
  }),
)

// ── Crew ────────────────────────────────────────────────────────────────

yardRouter.get(
  '/crew/moves',
  requireRoleOrToken('crew', 'yardmaster'),
  asyncHandler(async (req, res) => {
    const crew = req.query.crew === 'hump' || req.query.crew === 'trim' ? req.query.crew : 'all'
    res.json(await withSnapshotRead((client) => buildCrewView(client, crew)))
  }),
)

const CONFLICT_OUTCOMES = new Set(['refused_hold', 'refused_not_ready'])

yardRouter.post(
  '/crew/reports',
  requireRoleOrToken('crew', 'yardmaster'),
  asyncHandler(async (req, res) => {
    const body = crewReportSchema.parse(req.body)
    const result = await withTransaction((client) => applyCrewReport(client, body, req.user!.username))
    res.status(CONFLICT_OUTCOMES.has(result.outcome) ? 409 : 200).json({ result })
  }),
)

/** An offline queue flushing. Each report stands alone: one bad report doesn't sink the rest. */
yardRouter.post(
  '/crew/reports/batch',
  requireRoleOrToken('crew', 'yardmaster'),
  asyncHandler(async (req, res) => {
    const { reports } = z.object({ reports: z.array(crewReportSchema).min(1).max(200) }).parse(req.body)
    const results = []
    for (const report of reports) {
      try {
        results.push(await withTransaction((client) => applyCrewReport(client, report, req.user!.username)))
      } catch (err) {
        results.push({ clientReportId: report.clientReportId, moveKey: report.moveKey ?? null, outcome: 'rejected', duplicate: false, mismatch: false, message: err instanceof Error ? err.message : 'failed' })
      }
    }
    res.json({ results })
  }),
)

yardRouter.get(
  '/crew/reports',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM crew_reports ORDER BY received_at DESC LIMIT 60`)
    res.json({
      reports: rows.map((r) => ({ clientReportId: r.client_report_id, moveKey: r.move_key, kind: r.kind, exceptionType: r.exception_type, reporter: r.reporter, occurredAt: r.occurred_at, offline: r.offline, outcome: r.outcome, mismatch: r.mismatch, receivedAt: r.received_at })),
    })
  }),
)

// ── Holds ───────────────────────────────────────────────────────────────

yardRouter.get(
  '/holds',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const [holds, events] = await Promise.all([
      pool.query(`SELECT h.*, c.position, c.track_id, c.coupled_to, c.block_id FROM car_holds h LEFT JOIN cars c ON c.id = h.car_id ORDER BY h.updated_at DESC LIMIT 100`),
      pool.query(`SELECT * FROM hold_events ORDER BY received_at DESC LIMIT 100`),
    ])
    res.json({
      holds: holds.rows.map((h) => ({ holdId: h.hold_id, carId: h.car_id, status: h.status, reason: h.reason, streamId: h.stream_id, streamVersion: Number(h.stream_version), placedAt: h.placed_at, releasedAt: h.released_at, releasedBy: h.released_by, position: h.position, trackId: h.track_id, coupledTo: h.coupled_to, blockId: h.block_id })),
      events: events.rows.map((e) => ({ eventId: e.event_id, type: e.type, version: e.version, streamId: e.stream_id, streamVersion: Number(e.stream_version), occurredAt: e.occurred_at, holdId: e.hold_id, carId: e.car_id, outcome: e.outcome, via: e.via, receivedAt: e.received_at })),
    })
  }),
)

// ── Machine integrations (simulator, #19 webhook) ───────────────────────

integrationsRouter.use(requireIntegrationToken)

integrationsRouter.post(
  '/holds/events',
  asyncHandler(async (req, res) => {
    const list = Array.isArray(req.body) ? req.body : [req.body]
    const events = list.map((e) => holdEnvelope.parse(e))
    const results = []
    for (const event of events) results.push(await withTransaction((client) => applyHoldEvent(client, event, 'webhook')))
    res.json({ results })
  }),
)

integrationsRouter.post(
  '/clock',
  asyncHandler(async (req, res) => {
    const { now } = z.object({ now: iso }).parse(req.body)
    await advanceClock(pool, now)
    res.json({ ok: true })
  }),
)

integrationsRouter.post(
  '/arrivals',
  asyncHandler(async (req, res) => {
    const body = z.object({ inboundId: z.string(), at: iso, trackId: z.string().optional() }).parse(req.body)
    res.json(await withTransaction((client) => recordArrival(client, body.inboundId, body.at, body.trackId, 'dispatch')))
  }),
)

integrationsRouter.post(
  '/departures',
  asyncHandler(async (req, res) => {
    const body = z.object({ outboundId: z.string(), at: iso }).parse(req.body)
    res.json(await withTransaction((client) => recordDeparture(client, body.outboundId, body.at, 'dispatch')))
  }),
)

integrationsRouter.post(
  '/inbound/:id/eta',
  asyncHandler(async (req, res) => {
    const body = z.object({ eta: iso, reason: z.string().default('dispatch update') }).parse(req.body)
    res.json(await withTransaction((client) => slipTrain(client, req.params.id, body.eta, 'dispatch', body.reason)))
  }),
)

integrationsRouter.post(
  '/tracks/:id/status',
  asyncHandler(async (req, res) => {
    const body = z.object({ open: z.boolean(), reason: z.string().default('simulated') }).parse(req.body)
    res.json(await withTransaction((client) => setTrackStatus(client, req.params.id, body.open, body.reason, 'yard ops')))
  }),
)

integrationsRouter.post(
  '/shift/next',
  asyncHandler(async (_req, res) => {
    const out = await withTransaction(async (client) => {
      const yard = await readYard(client, true)
      const summary = await shiftMetrics(client, yard.shiftId, yard.simNow)
      const next = await rollShift(client, summary)
      return { closed: yard.shiftId, opened: next }
    })
    res.json(out)
  }),
)

/** The simulator's view of the yard: everything a crew could see, plus train schedules. */
integrationsRouter.get(
  '/sim-view',
  asyncHandler(async (_req, res) => {
    const body = await withSnapshotRead(async (client) => {
      const yard = await readYard(client)
      const crew = await buildCrewView(client, 'all')
      const { rows: inbound } = await client.query(`SELECT id, symbol, eta, actual_arrival FROM inbound_trains WHERE shift_id = $1 ORDER BY id`, [yard.shiftId])
      const { rows: outbound } = await client.query(`SELECT id, symbol, status, COALESCE(revised_departure, scheduled_departure) AS departure FROM outbound_trains WHERE shift_id = $1 ORDER BY id`, [yard.shiftId])
      const { rows: shift } = await client.query(`SELECT ends_at FROM shifts WHERE id = $1`, [yard.shiftId])
      const { rows: simInFlight } = await client.query(`SELECT key, crew_name, move FROM move_executions WHERE shift_id = $1 AND status = 'in_progress' AND crew_name LIKE 'crew-sim%'`, [yard.shiftId])
      return { ...crew, inbound, outbound, simInFlight, shiftEndsAt: shift[0]?.ends_at ?? null, seed: yard.seed }
    })
    res.json(body)
  }),
)

/** True when nothing is pending: no open trigger and no solve in flight. Lets a stepped run be deterministic. */
integrationsRouter.get(
  '/settled',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM replan_triggers WHERE solve_id IS NULL) AS triggers,
              (SELECT count(*)::int FROM solve_jobs WHERE lane = 'plan' AND status IN ('queued', 'running')) AS solves`,
    )
    res.json({ settled: rows[0].triggers === 0 && rows[0].solves === 0, triggers: rows[0].triggers, solves: rows[0].solves })
  }),
)
