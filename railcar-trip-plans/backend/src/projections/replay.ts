/**
 * Replay: rebuild a projection from position 0 of the event store into shadow tables, compare it with the
 * live projection row by row, record the result, and optionally swap it in.
 *
 *   npm run replay -- car-state            # rebuild + compare
 *   npm run replay -- eta --apply          # rebuild, compare, replace the live rows
 *   npm run replay -- all
 *
 * Projections rebuild without side effects: car-state does not re-emit ConnectionMissed, eta does not
 * re-emit EtaUpdated, exceptions only apply ExceptionOpened/Resolved. Decisions are already in the log.
 * Run it with consumers caught up (lag 0 on the streams page), or rows processed after the replay's
 * snapshot position will differ.
 */
process.env.SERVICE_NAME ??= 'replay'
import { pathToFileURL } from 'node:url'
import { pool } from '../shared/db.js'
import type { Queryable } from '../shared/db.js'
import { toEnvelope, type EventRow } from '../shared/events/envelope.js'
import { EVENT_COLUMNS } from '../shared/event-store.js'
import { applyPlanEvent } from '../shared/plans.js'
import { CAR_STATE_COLUMNS, refreshCar } from '../consumers/car-state/projection.js'
import { etaFromLog, writeCarEta } from '../consumers/eta/handler.js'
import { applyExceptionEvent } from '../consumers/exceptions/handler.js'

interface TableSpec {
  table: string
  key: string[]
  columns: string[]
}

interface Projection {
  name: string
  tables: TableSpec[]
  rebuild(q: Queryable, shadow: (table: string) => string, upTo: number): Promise<number>
}

async function eventsOfTypes(q: Queryable, types: string[], upTo: number): Promise<EventRow[]> {
  const { rows } = await q.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE type = ANY($1) AND position <= $2 ORDER BY position`, [types, upTo])
  return rows
}

export const PROJECTIONS: Projection[] = [
  {
    name: 'car-state',
    tables: [{ table: 'car_state', key: ['car_id'], columns: CAR_STATE_COLUMNS }],
    async rebuild(q, shadow, upTo) {
      const { rows } = await q.query<{ car_id: string }>(
        'SELECT DISTINCT ec.car_id FROM event_cars ec JOIN cars c USING (car_id) WHERE ec.position <= $1 ORDER BY 1',
        [upTo],
      )
      for (const { car_id } of rows) await refreshCar(q, car_id, shadow('car_state'), upTo)
      return rows.length
    },
  },
  {
    name: 'eta',
    tables: [{ table: 'car_eta', key: ['car_id'], columns: ['car_id', 'trip_id', 'plan_version', 'p10', 'p50', 'p90', 'confidence', 'as_of', 'final', 'basis'] }],
    async rebuild(q, shadow, upTo) {
      const { rows } = await q.query<{ car_id: string }>("SELECT DISTINCT partition_key AS car_id FROM events WHERE type = 'TripPlanCreated' AND position <= $1 ORDER BY 1", [upTo])
      for (const { car_id } of rows) {
        const { state, eta } = await etaFromLog(q, car_id, upTo)
        if (eta && state.plan) await writeCarEta(q, state, eta, shadow('car_eta'))
      }
      return rows.length
    },
  },
  {
    name: 'plans',
    tables: [
      { table: 'trip_plans', key: ['trip_id'], columns: ['trip_id', 'car_id', 'shipper_id', 'origin_yard', 'destination_yard', 'destination_customer', 'handoff_road', 'released_at', 'current_version', 'legs', 'updated_at'] },
      { table: 'trip_plan_versions', key: ['trip_id', 'version'], columns: ['trip_id', 'version', 'legs', 'reason_code', 'reason_text', 'revised_by', 'event_id', 'occurred_at'] },
      { table: 'plan_legs_current', key: ['trip_id', 'leg_seq'], columns: ['trip_id', 'leg_seq', 'car_id', 'plan_version', 'run_id', 'train_id', 'from_yard', 'to_yard', 'planned_departure', 'planned_arrival'] },
    ],
    async rebuild(q, shadow, upTo) {
      const rows = await eventsOfTypes(q, ['TripPlanCreated', 'TripPlanRevised'], upTo)
      const t = { tripPlans: shadow('trip_plans'), versions: shadow('trip_plan_versions'), legs: shadow('plan_legs_current') }
      for (const row of rows) await applyPlanEvent(q, toEnvelope(row) as never, t)
      return rows.length
    },
  },
  {
    name: 'exceptions',
    tables: [
      {
        table: 'exceptions',
        key: ['exception_id'],
        columns: ['exception_id', 'car_id', 'trip_id', 'shipper_id', 'type', 'severity', 'status', 'yard_id', 'summary', 'detail', 'opened_at', 'opened_event_id', 'resolved_at', 'resolved_by', 'resolution', 'version'],
      },
    ],
    async rebuild(q, shadow, upTo) {
      const rows = await eventsOfTypes(q, ['ExceptionOpened', 'ExceptionResolved'], upTo)
      for (const row of rows) await applyExceptionEvent(q, toEnvelope(row), shadow('exceptions'))
      return rows.length
    },
  },
]

const rowText = (cols: string[]) => `concat_ws('|', ${cols.map((c) => `COALESCE(${c}::text, '∅')`).join(', ')})`

async function checksum(q: Queryable, table: string, spec: TableSpec): Promise<{ rows: number; md5: string }> {
  const { rows } = await q.query<{ n: number; md5: string | null }>(
    `SELECT COUNT(*)::int AS n, md5(string_agg(${rowText(spec.columns)}, E'\\n' ORDER BY ${spec.key.join(', ')})) AS md5 FROM ${table}`,
  )
  return { rows: rows[0].n, md5: rows[0].md5 ?? 'empty' }
}

async function mismatches(q: Queryable, spec: TableSpec, shadow: string): Promise<string[]> {
  const on = spec.key.map((k) => `l.${k} = s.${k}`).join(' AND ')
  const keyOf = (alias: string) => `concat_ws('/', ${spec.key.map((k) => `${alias}.${k}::text`).join(', ')})`
  const { rows } = await q.query<{ k: string }>(
    `SELECT COALESCE(${keyOf('l')}, ${keyOf('s')}) AS k FROM ${spec.table} l FULL OUTER JOIN ${shadow} s ON ${on}
      WHERE l.${spec.key[0]} IS NULL OR s.${spec.key[0]} IS NULL
         OR ${rowText(spec.columns.map((c) => `l.${c}`))} <> ${rowText(spec.columns.map((c) => `s.${c}`))}
      LIMIT 20`,
  )
  return rows.map((r) => `${spec.table}:${r.k}`)
}

export interface ReplayReport {
  projection: string
  eventsRead: number
  upTo: number
  rowsLive: number
  rowsRebuilt: number
  checksumLive: string
  checksumRebuilt: string
  matches: boolean
  mismatches: string[]
  applied: boolean
}

export async function replay(name: string, apply = false): Promise<ReplayReport> {
  const projection = PROJECTIONS.find((p) => p.name === name)
  if (!projection) throw new Error(`Unknown projection ${name}. Known: ${PROJECTIONS.map((p) => p.name).join(', ')}`)
  const started = new Date()
  const shadow = (table: string) => `${table}__replay`
  for (const spec of projection.tables) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${shadow(spec.table)} (LIKE ${spec.table} INCLUDING ALL)`)
    await pool.query(`TRUNCATE ${shadow(spec.table)}`)
  }
  const { rows } = await pool.query<{ p: number | null }>('SELECT MAX(position) AS p FROM events')
  const upTo = rows[0].p ?? 0
  const eventsRead = await projection.rebuild(pool, shadow, upTo)

  let rowsLive = 0
  let rowsRebuilt = 0
  const live: string[] = []
  const rebuilt: string[] = []
  const diff: string[] = []
  for (const spec of projection.tables) {
    const a = await checksum(pool, spec.table, spec)
    const b = await checksum(pool, shadow(spec.table), spec)
    rowsLive += a.rows
    rowsRebuilt += b.rows
    live.push(a.md5)
    rebuilt.push(b.md5)
    if (a.md5 !== b.md5) diff.push(...(await mismatches(pool, spec, shadow(spec.table))))
  }
  const matches = live.join(',') === rebuilt.join(',')
  if (apply) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const spec of projection.tables) {
        await client.query(`LOCK TABLE ${spec.table} IN ACCESS EXCLUSIVE MODE`)
        await client.query(`TRUNCATE ${spec.table}`)
        await client.query(`INSERT INTO ${spec.table} SELECT * FROM ${shadow(spec.table)}`)
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
  const report: ReplayReport = {
    projection: name, eventsRead, upTo, rowsLive, rowsRebuilt, checksumLive: live.join(','), checksumRebuilt: rebuilt.join(','), matches, mismatches: diff, applied: apply,
  }
  await pool.query(
    `INSERT INTO replay_runs (projection, started_at, finished_at, events_read, rows_live, rows_rebuilt, checksum_live, checksum_rebuilt, matches, applied, mismatches)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10)`,
    [name, started, eventsRead, rowsLive, rowsRebuilt, report.checksumLive, report.checksumRebuilt, matches, apply, JSON.stringify(diff)],
  )
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const target = args.find((a) => !a.startsWith('--')) ?? 'all'
  const apply = args.includes('--apply')
  const names = target === 'all' ? PROJECTIONS.map((p) => p.name) : [target]
  let ok = true
  try {
    for (const n of names) {
      const r = await replay(n, apply)
      ok &&= r.matches
      console.log(
        `${r.projection.padEnd(10)} rebuilt from ${r.eventsRead} inputs up to position ${r.upTo}: live ${r.rowsLive} rows, rebuilt ${r.rowsRebuilt} rows — ${r.matches ? 'IDENTICAL' : 'DIFFERENT'}${r.applied ? ' (applied)' : ''}`,
      )
      if (!r.matches) console.log(`  first differences: ${r.mismatches.join(', ')}`)
    }
  } catch (err) {
    console.error((err as Error).message)
    ok = false
  } finally {
    await pool.end()
  }
  process.exitCode = ok ? 0 : 1
}
