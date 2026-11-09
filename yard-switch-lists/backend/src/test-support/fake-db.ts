/**
 * A tiny in-memory stand-in for the handful of statements the hold consumer and
 * the crew-report path issue, so those rules can be unit tested without Docker.
 * It fakes behaviour by matching statement text, so it proves the logic around
 * the SQL, not the SQL. The live e2e runs the real statements on PostgreSQL.
 */
import type { PlanMove } from '../domain/types.js'

export interface FakeCar {
  id: string
  position: string
  track_id: string | null
  coupled_to: string | null
  coupled_seq: number | null
  position_as_of: string | null
  length_ft: number
}

export class FakeDb {
  stateVersion = 10
  simNow = new Date('2026-11-09T08:00:00Z')
  headId = 'head'
  holdEvents = new Map<string, { outcome: string }>()
  holds = new Map<string, { hold_id: string; car_id: string; status: string; stream_version: number }>()
  cars = new Map<string, FakeCar>()
  trains = new Map<string, { symbol: string; status: string }>()
  tracks = new Map<string, { kind: string; capacity_ft: number; is_open: boolean }>()
  headMoves: PlanMove[] = []
  execs = new Map<string, { status: string; move: PlanMove | null; started_at: string | null }>()
  reports = new Map<string, { response: unknown }>()
  handlings = new Set<string>()
  capacityEvents: unknown[] = []
  alerts = new Map<string, string>()
  triggers: { kind: string; detail: unknown }[] = []

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, ' ').trim()
    const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowCount: r.length })
    const none = rows([])

    if (sql.startsWith('SELECT * FROM yard_state')) {
      return rows([{ shift_id: 1, seed: 42, state_version: this.stateVersion, sim_now: this.simNow, head_version_id: this.headId, working_version_id: this.headId, auto_publish: true, planner_settings: {} }])
    }
    if (sql.startsWith('UPDATE yard_state SET state_version')) {
      this.stateVersion++
      return rows([{ state_version: this.stateVersion, shift_id: 1, sim_now: this.simNow }])
    }
    if (sql.startsWith('SELECT shift_id FROM yard_state')) return rows([{ shift_id: 1 }])
    if (sql.startsWith('INSERT INTO yard_state_log')) return none
    if (sql.startsWith('INSERT INTO replan_triggers')) {
      this.triggers.push({ kind: params[1] as string, detail: JSON.parse(params[2] as string) })
      return none
    }
    if (sql.startsWith('INSERT INTO alerts')) {
      this.alerts.set(params[0] as string, params[1] as string)
      return none
    }
    if (sql.startsWith('UPDATE alerts')) return none

    // Holds
    if (sql.startsWith('SELECT outcome FROM hold_events')) {
      const hit = this.holdEvents.get(params[0] as string)
      return rows(hit ? [hit] : [])
    }
    if (sql.startsWith('INSERT INTO hold_events')) {
      if (this.holdEvents.has(params[0] as string)) return { rows: [], rowCount: 0 }
      this.holdEvents.set(params[0] as string, { outcome: params[9] as string })
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('SELECT 1 FROM car_holds')) {
      return rows([...this.holds.values()].filter((h) => h.car_id === params[0] && (h.status === 'active' || h.status === 'bad_ordered')).map(() => ({ '?column?': 1 })))
    }
    if (sql.startsWith('INSERT INTO car_holds')) {
      const existing = this.holds.get(params[0] as string)
      const version = Number(params[6])
      if (existing && existing.stream_version >= version) return none
      this.holds.set(params[0] as string, { hold_id: params[0] as string, car_id: params[1] as string, status: params[3] as string, stream_version: version })
      return rows([{ hold_id: params[0] }])
    }
    if (sql.startsWith('SELECT DISTINCT car_id FROM car_holds')) {
      const ids = params[0] as string[]
      return rows([...this.holds.values()].filter((h) => ids.includes(h.car_id) && (h.status === 'active' || h.status === 'bad_ordered')).map((h) => ({ car_id: h.car_id })))
    }
    if (sql.startsWith('SELECT position, coupled_to, track_id FROM cars')) {
      const c = this.cars.get(params[0] as string)
      return rows(c ? [{ position: c.position, coupled_to: c.coupled_to, track_id: c.track_id }] : [])
    }
    if (sql.startsWith('SELECT symbol, status FROM outbound_trains')) {
      const t = this.trains.get(params[0] as string)
      return rows(t ? [t] : [])
    }
    if (sql.startsWith('SELECT key FROM move_executions')) {
      const hit = [...this.execs.entries()].find(([, e]) => e.status === 'in_progress' && e.move?.carIds.includes(params[0] as string))
      return rows(hit ? [{ key: hit[0] }] : [])
    }

    // Crew reports
    if (sql.startsWith('SELECT response FROM crew_reports')) {
      const hit = this.reports.get(params[0] as string)
      return rows(hit ? [hit] : [])
    }
    if (sql.startsWith('INSERT INTO crew_reports')) {
      this.reports.set(params[0] as string, { response: JSON.parse(params[11] as string) })
      return none
    }
    if (sql.startsWith('SELECT * FROM moves WHERE list_id')) {
      return rows(
        this.headMoves.map((m) => ({
          key: m.key,
          kind: m.kind,
          crew: m.crew,
          car_ids: m.carIds,
          from_track_id: m.fromTrackId,
          to_track_id: m.toTrackId,
          block_id: m.blockId,
          inbound_id: m.inboundId,
          outbound_id: m.outboundId,
          planned_start: new Date(m.plannedStart),
          planned_end: new Date(m.plannedEnd),
        })),
      )
    }
    if (sql.startsWith('SELECT status, move FROM move_executions') || sql.startsWith('SELECT status FROM move_executions')) {
      const e = this.execs.get(params[1] as string)
      return rows(e ? [{ status: e.status, move: e.move }] : [])
    }
    if (sql.startsWith('SELECT move FROM move_executions')) {
      const e = this.execs.get(params[1] as string)
      return rows(e ? [{ move: e.move }] : [])
    }
    if (sql.startsWith('SELECT m.*, l.version_no FROM moves')) return none
    if (sql.startsWith('INSERT INTO move_executions')) {
      const key = params[1] as string
      const prior = this.execs.get(key)
      this.execs.set(key, { status: params[2] as string, started_at: prior?.started_at ?? (params[4] as string | null), move: params[6] ? (JSON.parse(params[6] as string) as PlanMove) : (prior?.move ?? null) })
      return none
    }
    if (sql.startsWith('UPDATE move_executions SET started_at')) {
      const e = this.execs.get(params[1] as string)
      if (e) e.started_at = params[2] as string
      return none
    }
    if (sql.startsWith('SELECT count(*)::int AS n FROM cars WHERE id = ANY')) {
      const ids = params[0] as string[]
      const n = ids.filter((id) => {
        const c = this.cars.get(id)
        return !c || c.track_id !== params[1] || c.position !== 'on_track'
      }).length
      return rows([{ n }])
    }
    if (sql.startsWith('SELECT kind FROM tracks')) {
      const t = this.tracks.get(params[0] as string)
      return rows(t ? [{ kind: t.kind }] : [])
    }
    if (sql.startsWith('UPDATE cars SET track_id')) {
      const c = this.cars.get(params[0] as string)
      const at = params[4] as string
      if (c && c.position !== 'departed' && (!c.position_as_of || c.position_as_of <= at)) {
        c.track_id = params[1] as string
        c.position = 'on_track'
        c.coupled_to = params[2] as string | null
        c.coupled_seq = params[3] as number | null
        c.position_as_of = at
      }
      return none
    }
    if (sql.startsWith("UPDATE cars SET position = 'unknown'")) {
      const at = params[1] as string
      for (const id of params[0] as string[]) {
        const c = this.cars.get(id)
        if (c && c.position !== 'departed' && (!c.position_as_of || c.position_as_of <= at)) {
          c.position = 'unknown'
          c.track_id = null
          c.coupled_to = null
          c.position_as_of = at
        }
      }
      return none
    }
    if (sql.startsWith('INSERT INTO car_handlings')) {
      this.handlings.add(`${params[1]}|${params[2]}`)
      return none
    }
    if (sql.startsWith('SELECT t.capacity_ft')) {
      const track = this.tracks.get(params[0] as string)
      const feet = [...this.cars.values()].filter((c) => c.track_id === params[0] && c.position === 'on_track').reduce((s, c) => s + c.length_ft, 0)
      return rows(track ? [{ capacity_ft: track.capacity_ft, feet }] : [])
    }
    if (sql.startsWith('INSERT INTO capacity_events')) {
      this.capacityEvents.push(params)
      return none
    }
    if (sql.startsWith('UPDATE tracks SET is_open')) {
      const t = this.tracks.get(params[0] as string)
      if (t) t.is_open = false
      return none
    }
    throw new Error(`FakeDb: no handler for: ${sql.slice(0, 90)}`)
  }
}
