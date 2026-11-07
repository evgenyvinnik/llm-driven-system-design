/**
 * Test helper: an in-memory stand-in for the SQL the event store and the case
 * index issue, so unit tests run the real store, repositories and deciders
 * without PostgreSQL. Compose it with a test's own query handler.
 * @module events/testing
 */
import { familyOf, partitionKeyOf, streamTypeOf, CATALOG } from './catalog.js'
import type { StoredEventRow } from './envelope.js'

type Result = { rows: unknown[]; rowCount: number }

export interface FakeEventStore {
  rows: StoredEventRow[]
  caseIndex: Map<string, Record<string, unknown>>
  /** Returns a result for event-store SQL, or undefined for anything else. */
  handle: (sql: string, params?: unknown[]) => Result | undefined
  /** Appends events directly (test setup), as if committed earlier. */
  seed: (streamId: string, events: Array<{ type: string; payload: Record<string, unknown>; version?: number; occurredAt?: string }>) => StoredEventRow[]
}

export function createFakeEventStore(): FakeEventStore {
  const rows: StoredEventRow[] = []
  const caseIndex = new Map<string, Record<string, unknown>>()
  let position = 0
  const versionOf = (streamId: string) => rows.filter((r) => r.stream_id === streamId).reduce((m, r) => Math.max(m, r.stream_version), 0)

  const push = (r: Omit<StoredEventRow, 'global_position' | 'committed_at'>): StoredEventRow => {
    const row = { ...r, global_position: ++position, committed_at: new Date('2026-11-05T12:00:00Z') } as StoredEventRow
    rows.push(row)
    return row
  }

  const seed: FakeEventStore['seed'] = (streamId, events) =>
    events.map((e) => {
      const streamType = streamTypeOf(streamId)
      return push({
        event_id: `00000000-0000-4000-8000-${String(position + 1).padStart(12, '0')}`,
        stream_id: streamId, stream_type: streamType, stream_version: versionOf(streamId) + 1, type: e.type, version: e.version ?? CATALOG[e.type].latest,
        family: familyOf(e.type, streamType, e.payload), partition_key: partitionKeyOf(e.type, streamType, streamId, e.payload),
        occurred_at: e.occurredAt ?? '2026-11-05T12:00:00Z', recorded_at: e.occurredAt ?? '2026-11-05T12:00:00Z', correlation_id: 'test', causation_id: null,
        actor: 'test', tags: [], payload: e.payload,
      })
    })

  const handle = (sql: string, params: unknown[] = []): Result | undefined => {
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('pg_notify')) return { rows: [], rowCount: 1 }
    if (sql.includes('max(stream_version)')) {
      const ids = params[0] as string[]
      const out = ids.filter((id) => versionOf(id) > 0).map((id) => ({ stream_id: id, v: versionOf(id) }))
      return { rows: out, rowCount: out.length }
    }
    if (sql.startsWith('SELECT * FROM events WHERE stream_id = $1')) {
      const out = rows.filter((r) => r.stream_id === params[0]).sort((a, b) => a.stream_version - b.stream_version)
      return { rows: out, rowCount: out.length }
    }
    if (sql.startsWith('SELECT * FROM events WHERE stream_id = ANY($1)')) {
      const ids = params[0] as string[]
      const types = params[1] as string[] | undefined
      const out = rows.filter((r) => ids.includes(r.stream_id) && (!types || types.includes(r.type)))
      return { rows: out, rowCount: out.length }
    }
    if (sql.includes('INSERT INTO events')) {
      const [ids, streams, streamTypes, versions, types, schemaVersions, families, keys, occurred, recorded, correlations, causations, actors, tags, payloads] = params as unknown[][]
      const out = ids.map((_, i) => {
        if (rows.some((r) => r.stream_id === streams[i] && r.stream_version === versions[i])) throw Object.assign(new Error('duplicate key'), { code: '23505' })
        return push({
          event_id: String(ids[i]), stream_id: String(streams[i]), stream_type: streamTypes[i] as StoredEventRow['stream_type'], stream_version: Number(versions[i]),
          type: String(types[i]), version: Number(schemaVersions[i]), family: String(families[i]), partition_key: String(keys[i]),
          occurred_at: occurred[i] as Date, recorded_at: recorded[i] as Date, correlation_id: String(correlations[i]), causation_id: (causations[i] as string | null) ?? null,
          actor: String(actors[i]), tags: String(tags[i]).replace(/[{}"]/g, '').split(',').filter(Boolean), payload: JSON.parse(String(payloads[i])),
        })
      })
      return { rows: out, rowCount: out.length }
    }
    if (sql.includes('INSERT INTO case_index')) {
      const [caseId, caseType, tripId, carId, kind, position, isOpen, workOrderId, holdYard, holdStatus, version] = params
      caseIndex.set(String(caseId), { case_id: caseId, case_type: caseType, trip_id: tripId, car_id: carId, kind, position, is_open: isOpen, work_order_id: workOrderId, hold_yard_id: holdYard, hold_status: holdStatus, version })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM case_index WHERE work_order_id = $1')) {
      const hit = [...caseIndex.values()].find((c) => c.work_order_id === params[0])
      return { rows: hit ? [{ case_id: hit.case_id }] : [], rowCount: hit ? 1 : 0 }
    }
    return undefined
  }

  return { rows, caseIndex, handle, seed }
}
