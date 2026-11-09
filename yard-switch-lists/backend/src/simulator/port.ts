/**
 * How the simulator talks to the yard. Live, it's a separate process using the
 * same HTTP API as any other system, with a token. In the seed, the same engine
 * runs in-process and calls the services directly, so the demo data is produced
 * by the code the live system runs rather than by hand-written rows.
 * @module simulator/port
 */
import { config } from '../shared/config.js'
import { withSnapshotRead, withTransaction, pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { applyCrewReport, type CrewReport } from '../execution/reports.js'
import { advanceClock, recordArrival, recordDeparture, setTrackStatus, slipTrain } from '../execution/yard-events.js'
import { shiftMetrics } from '../metrics/shift.js'
import { buildCrewView } from '../plans/board.js'
import { readYard } from '../plans/state.js'
import { rollShift } from '../plans/yard-load.js'
import { coalesceTriggers } from '../worker/coalescer.js'
import { claimJob } from '../worker/jobs.js'
import { runPlanJob } from '../worker/run-plan.js'

export interface SimMove {
  key: string
  kind: string
  crew: 'road' | 'hump' | 'trim'
  carIds: string[]
  fromTrackId: string | null
  toTrackId: string
  outboundId: string | null
  plannedStart: string
  plannedEnd: string
  status: string
  ready: boolean
}

export interface SimView {
  now: string
  shiftId: number
  versionNo: number | null
  moves: SimMove[]
  inbound: { id: string; symbol: string; eta: string; actual_arrival: string | null }[]
  outbound: { id: string; symbol: string; status: string; departure: string }[]
  simInFlight: { key: string; crew_name: string; move: SimMove }[]
  shiftEndsAt: string | null
  seed: number
}

export interface ReportOutcome {
  outcome: string
  duplicate?: boolean
  message?: string
}

export interface YardPort {
  view(): Promise<SimView>
  clock(nowIso: string): Promise<void>
  arrival(inboundId: string, atIso: string): Promise<{ trackId?: string | null; duplicate?: boolean }>
  departure(outboundId: string, atIso: string): Promise<{ status: string; cars?: number }>
  report(report: CrewReport, reporter: string): Promise<ReportOutcome>
  slip(inboundId: string, etaIso: string, reason: string): Promise<{ slipMin: number; symbol: string }>
  trackStatus(trackId: string, open: boolean, reason: string): Promise<unknown>
  nextShift(): Promise<{ closed: number; opened: number }>
  settle(): Promise<void>
}

export function httpPort(): YardPort {
  const base = `${config.apiUrl}/api/v1`
  const call = async <T>(path: string, method = 'GET', body?: unknown, acting?: string): Promise<{ status: number; data: T }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-integration-token': config.integrationToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(acting ? { 'x-acting-as': acting } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await response.json().catch(() => ({}))) as T
    if (!response.ok && response.status !== 409) {
      throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data).slice(0, 300)}`)
    }
    return { status: response.status, data }
  }
  return {
    view: async () => (await call<SimView>('/integrations/sim-view')).data,
    clock: async (now) => void (await call('/integrations/clock', 'POST', { now })),
    arrival: async (inboundId, at) => (await call<{ trackId?: string }>('/integrations/arrivals', 'POST', { inboundId, at })).data,
    departure: async (outboundId, at) => (await call<{ status: string; cars?: number }>('/integrations/departures', 'POST', { outboundId, at })).data,
    report: async (report, reporter) => (await call<{ result: ReportOutcome }>('/crew/reports', 'POST', report, reporter)).data.result,
    slip: async (inboundId, eta, reason) => (await call<{ slipMin: number; symbol: string }>(`/integrations/inbound/${inboundId}/eta`, 'POST', { eta, reason })).data,
    trackStatus: async (trackId, open, reason) => (await call(`/integrations/tracks/${trackId}/status`, 'POST', { open, reason })).data,
    nextShift: async () => (await call<{ closed: number; opened: number }>('/integrations/shift/next', 'POST', {})).data,
    settle: async () => {
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const { data } = await call<{ settled: boolean }>('/integrations/settled')
        if (data.settled) return
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      logger.warn('settle timed out')
    },
  }
}

/** Runs everything in this process, including the planner, so no worker is needed. */
export function directPort(): YardPort {
  return {
    view: () =>
      withSnapshotRead(async (client) => {
        const yard = await readYard(client)
        const crew = await buildCrewView(client, 'all')
        const { rows: inbound } = await client.query(`SELECT id, symbol, eta, actual_arrival FROM inbound_trains WHERE shift_id = $1 ORDER BY id`, [yard.shiftId])
        const { rows: outbound } = await client.query(`SELECT id, symbol, status, COALESCE(revised_departure, scheduled_departure) AS departure FROM outbound_trains WHERE shift_id = $1 ORDER BY id`, [yard.shiftId])
        const { rows: shift } = await client.query(`SELECT ends_at FROM shifts WHERE id = $1`, [yard.shiftId])
        const { rows: simInFlight } = await client.query(`SELECT key, crew_name, move FROM move_executions WHERE shift_id = $1 AND status = 'in_progress' AND crew_name LIKE 'crew-sim%'`, [yard.shiftId])
        return { ...crew, inbound, outbound, simInFlight, shiftEndsAt: shift[0]?.ends_at ?? null, seed: yard.seed } as unknown as SimView
      }),
    clock: (now) => advanceClock(pool, now),
    arrival: (inboundId, at) => withTransaction((client) => recordArrival(client, inboundId, at, undefined, 'dispatch')),
    departure: (outboundId, at) => withTransaction((client) => recordDeparture(client, outboundId, at, 'dispatch')),
    report: (report, reporter) => withTransaction((client) => applyCrewReport(client, report, reporter)),
    slip: (inboundId, eta, reason) => withTransaction((client) => slipTrain(client, inboundId, eta, 'dispatch', reason)),
    trackStatus: (trackId, open, reason) => withTransaction((client) => setTrackStatus(client, trackId, open, reason, 'yard ops')),
    nextShift: () =>
      withTransaction(async (client) => {
        const yard = await readYard(client, true)
        const summary = await shiftMetrics(client, yard.shiftId, yard.simNow)
        const next = await rollShift(client, summary)
        return { closed: yard.shiftId, opened: next }
      }),
    settle: async () => {
      for (let i = 0; i < 20; i++) {
        await coalesceTriggers(true)
        const job = await claimJob('plan', 'inline')
        if (!job) return
        await runPlanJob(job, () => false)
      }
    },
  }
}
