/**
 * Applying projections in PostgreSQL, and rebuilding them by replay.
 *
 * Live: one transaction per event per projection, serialised per projection by
 * an advisory lock. The natural idempotency key is the stream version: an event
 * whose version is not above the last one applied for its stream is a
 * redelivery and is skipped.
 *
 * Replay: under the same lock, checksum the live table, delete it, fold every
 * event from global position 0 through the same reducer, write the result and
 * checksum again. Equal checksums mean the live projection is exactly what the
 * event log says.
 * @module projector/store
 */
import type { Client } from '../shared/db.js'
import { lockKey, withTransaction } from '../shared/db.js'
import { rowToEnvelope } from '../shared/event-store.js'
import type { Envelope } from '../shared/events/envelope.js'
import { logger } from '../shared/logger.js'
import { foldProjection, type Doc, type Projection } from './projections.js'

export type ApplyOutcome = 'applied' | 'duplicate' | 'ignored'

export async function lockProjection(client: Client, projection: Projection): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey(`projection:${projection.name}`)])
}

async function upsertDocs(client: Client, projection: Projection, docs: Array<{ key: string; doc: Doc }>): Promise<void> {
  if (docs.length === 0) return
  const cols = ['key', ...projection.columnNames, 'doc']
  const values: unknown[] = []
  const tuples = docs.map(({ key, doc }, i) => {
    const row = [key, ...projection.columns(doc), JSON.stringify(doc)]
    values.push(...row)
    return `(${row.map((_, j) => `$${i * row.length + j + 1}`).join(', ')})`
  })
  const updates = cols.filter((c) => c !== 'key').map((c) => `${c} = EXCLUDED.${c}`)
  await client.query(`INSERT INTO ${projection.table} (${cols.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (key) DO UPDATE SET ${updates.join(', ')}`, values)
}

/** Applies one event to one projection inside the caller's transaction. */
export async function applyEvent(client: Client, projection: Projection, env: Envelope): Promise<ApplyOutcome> {
  if (!projection.handles(env)) return 'ignored'
  await lockProjection(client, projection)
  const { rows } = await client.query<{ version: number }>('SELECT version FROM projection_versions WHERE projection = $1 AND stream_id = $2 FOR UPDATE', [projection.name, env.streamId])
  const last = rows[0]?.version ?? 0
  if (env.streamVersion <= last) return 'duplicate'
  if (env.streamVersion !== last + 1) logger.warn({ projection: projection.name, stream: env.streamId, last, got: env.streamVersion }, 'projection version gap; applying (rebuild with replay if this persists)')
  const keys = projection.keys(env)
  const current = new Map<string, Doc | undefined>()
  if (keys.length) {
    const docs = await client.query<{ key: string; doc: Doc }>(`SELECT key, doc FROM ${projection.table} WHERE key = ANY($1::text[])`, [keys])
    for (const k of keys) current.set(k, docs.rows.find((d) => d.key === k)?.doc)
  }
  await upsertDocs(client, projection, projection.apply(env, current))
  await client.query(
    `INSERT INTO projection_versions (projection, stream_id, version) VALUES ($1, $2, $3)
     ON CONFLICT (projection, stream_id) DO UPDATE SET version = EXCLUDED.version`,
    [projection.name, env.streamId, env.streamVersion],
  )
  await client.query(
    `INSERT INTO projection_checkpoints (projection, last_position, last_recorded_at, events_applied, updated_at) VALUES ($1, $2, $3, 1, now())
     ON CONFLICT (projection) DO UPDATE SET last_position = GREATEST(projection_checkpoints.last_position, EXCLUDED.last_position),
       last_recorded_at = GREATEST(projection_checkpoints.last_recorded_at, EXCLUDED.last_recorded_at),
       events_applied = projection_checkpoints.events_applied + 1, updated_at = now()`,
    [projection.name, env.globalPosition ?? 0, env.recordedAt],
  )
  return 'applied'
}

export async function checksum(client: Client, projection: Projection): Promise<{ rows: number; md5: string }> {
  const { rows } = await client.query<{ n: number; md5: string }>(
    `SELECT count(*)::int AS n, md5(COALESCE(string_agg(key || '=' || doc::text, '|' ORDER BY key), '')) AS md5 FROM ${projection.table}`,
  )
  return { rows: rows[0].n, md5: rows[0].md5 }
}

export interface ReplayResult {
  projection: string
  eventsReplayed: number
  before: { rows: number; md5: string }
  after: { rows: number; md5: string }
  match: boolean
  /** Streams where the live projection had not yet applied the latest event when the replay started. */
  liveStreamsBehind: number
  ms: number
}

/** Rebuilds a projection from position 0 and reports whether it matches what was live. */
export async function rebuildProjection(projection: Projection): Promise<ReplayResult> {
  const started = Date.now()
  return withTransaction(async (client) => {
    await lockProjection(client, projection)
    const before = await checksum(client, projection)
    const { rows } = await client.query('SELECT * FROM events ORDER BY global_position')
    const events = rows.map(rowToEnvelope).filter((e) => projection.handles(e))
    const latest = new Map<string, number>()
    for (const e of events) latest.set(e.streamId, Math.max(latest.get(e.streamId) ?? 0, e.streamVersion))
    const live = await client.query<{ stream_id: string; version: number }>('SELECT stream_id, version FROM projection_versions WHERE projection = $1', [projection.name])
    const liveMap = new Map(live.rows.map((r) => [r.stream_id, r.version]))
    let behind = 0
    for (const [stream, v] of latest) if ((liveMap.get(stream) ?? 0) < v) behind++

    const { docs, versions } = foldProjection(projection, events)
    await client.query(`DELETE FROM ${projection.table}`)
    await client.query('DELETE FROM projection_versions WHERE projection = $1', [projection.name])
    const entries = [...docs.entries()].map(([key, doc]) => ({ key, doc }))
    for (let i = 0; i < entries.length; i += 200) await upsertDocs(client, projection, entries.slice(i, i + 200))
    const vEntries = [...versions.entries()]
    for (let i = 0; i < vEntries.length; i += 500) {
      const chunk = vEntries.slice(i, i + 500)
      await client.query(
        `INSERT INTO projection_versions (projection, stream_id, version) SELECT $1, s, v FROM unnest($2::text[], $3::int[]) AS t(s, v)`,
        [projection.name, chunk.map(([s]) => s), chunk.map(([, v]) => v)],
      )
    }
    const lastEvent = events.at(-1)
    await client.query(
      `INSERT INTO projection_checkpoints (projection, last_position, last_recorded_at, events_applied, rebuilt_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (projection) DO UPDATE SET last_position = EXCLUDED.last_position, last_recorded_at = EXCLUDED.last_recorded_at,
         events_applied = EXCLUDED.events_applied, rebuilt_at = now(), updated_at = now()`,
      [projection.name, lastEvent?.globalPosition ?? 0, lastEvent?.recordedAt ?? null, events.length],
    )
    const after = await checksum(client, projection)
    return { projection: projection.name, eventsReplayed: events.length, before, after, match: before.md5 === after.md5, liveStreamsBehind: behind, ms: Date.now() - started }
  })
}
