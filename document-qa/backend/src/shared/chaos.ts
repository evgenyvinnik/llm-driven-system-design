/**
 * Worker-side fault switches stored in PostgreSQL (`chaos_switches`), so the
 * API can arm them and whichever worker gets there first consumes them.
 *
 * - `kill_mid_chunk` (armed count): a worker exits the process after writing
 *   half of a version's chunks, mid-stage, without acking its ticket.
 * - `blob_outage` (armed count): the next N blob-store calls by workers fail
 *   as if MinIO were down (purge then retries with backoff).
 * - `acl_sync_paused` (0/1): the lazy index-metadata sync stops, leaving index
 *   rows with the old scope, which is how the demo proves the re-check works.
 * - `purge_paused` (0/1): purges wait, like a legal hold. Tombstoned documents
 *   stay invisible; only the physical removal is postponed. The e2e uses it to
 *   prove a cached answer is rejected by validation, not saved by the purge.
 * - `activation_delay_ms`: the index stage waits this long after indexing a
 *   new version and before switching to it, widening the window in which both
 *   versions sit in the index.
 * @module shared/chaos
 */
import { pool, type Queryable } from './db.js'

export const CHAOS_SWITCHES = ['kill_mid_chunk', 'blob_outage', 'acl_sync_paused', 'purge_paused', 'activation_delay_ms'] as const
export type ChaosSwitch = (typeof CHAOS_SWITCHES)[number]

/** Atomically consumes one armed fault. True when it fired. */
export async function consumeArmed(name: ChaosSwitch, db: Queryable = pool): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE chaos_switches SET value = value - 1, updated_at = now() WHERE name = $1 AND value > 0`, [name])
  return (rowCount ?? 0) > 0
}

export async function readSwitch(name: ChaosSwitch, db: Queryable = pool): Promise<number> {
  const { rows } = await db.query<{ value: number }>(`SELECT value FROM chaos_switches WHERE name = $1`, [name])
  return rows[0]?.value ?? 0
}

export async function readAll(db: Queryable = pool): Promise<Record<ChaosSwitch, number>> {
  const { rows } = await db.query<{ name: ChaosSwitch; value: number }>(`SELECT name, value FROM chaos_switches`)
  const out = Object.fromEntries(CHAOS_SWITCHES.map((n) => [n, 0])) as Record<ChaosSwitch, number>
  for (const r of rows) if ((CHAOS_SWITCHES as readonly string[]).includes(r.name)) out[r.name] = r.value
  return out
}

export async function setSwitch(name: ChaosSwitch, value: number, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO chaos_switches (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [name, value],
  )
}

/** Throws like an unreachable blob store when a `blob_outage` fault is armed. */
export async function maybeBlobOutage(): Promise<void> {
  if (await consumeArmed('blob_outage')) {
    const err = new Error('Blob store unavailable (simulated MinIO outage)') as Error & { code: string }
    err.code = 'ECONNREFUSED'
    throw err
  }
}
