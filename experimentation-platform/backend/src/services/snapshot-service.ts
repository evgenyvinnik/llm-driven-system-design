/**
 * Ruleset snapshots: compile inside the write transaction, publish after
 * commit, serve from memory.
 *
 *   write txn ──▶ bump environments.snapshot_version (row lock serializes writers)
 *             ──▶ compile every flag of the environment ──▶ INSERT snapshots (immutable)
 *   commit    ──▶ Valkey: latest body (forward-only CAS) + PUBLISH {environment, version}
 *   every API instance's subscriber ──▶ load that version ──▶ memory ──▶ push to its SSE clients
 *
 * If a pub/sub message is lost (Valkey restart, instance mid-reconnect), the
 * reconcile loop reads environments.snapshot_version from PostgreSQL every few
 * seconds, so staleness is bounded by SNAPSHOT_RECONCILE_MS.
 * @module services/snapshot-service
 */
import type pg from 'pg'
import type { Redis } from 'ioredis'
import { compileSnapshot, snapshotEtag, type CompilableFlag } from '../domain/compile.js'
import { createRedisConnection, keys, redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import type { Snapshot } from '../shared/evaluation.js'
import { logger } from '../shared/logger.js'
import { snapshotCompiles, snapshotReloads, snapshotVersion } from '../shared/metrics.js'

export interface CompiledSnapshot {
  environment: string
  version: number
  etag: string
  body: Snapshot
  json: string
}

export interface SnapshotNotice {
  environment: string
  version: number
  etag: string
  reason: string
  publishedAt: number
  origin: string
}

const latest = new Map<string, CompiledSnapshot>()
/** A few recent versions per environment, for clients that fetch a pushed version by number. */
const recent = new Map<string, CompiledSnapshot>()
const listeners = new Set<(snap: CompiledSnapshot, notice: SnapshotNotice) => void>()

interface FlagConfigRow {
  key: string
  kind: CompilableFlag['kind']
  unit_type: CompilableFlag['unitType']
  salt: string
  variants: CompilableFlag['variants']
  default_variant: string
  status: CompilableFlag['status']
  version: number
  rules: CompilableFlag['rules']
  fallthrough: CompilableFlag['fallthrough']
  allocation: CompilableFlag['allocation']
}

async function loadCompilable(client: pg.PoolClient, environment: string): Promise<CompilableFlag[]> {
  const { rows } = await client.query<FlagConfigRow>(
    `SELECT f.key, f.kind, f.unit_type, f.salt, f.variants, f.default_variant,
            c.status, c.version, c.rules, c.fallthrough, c.allocation
       FROM flags f JOIN flag_configs c ON c.flag_id = f.id
      WHERE c.environment = $1`,
    [environment],
  )
  return rows.map((r) => ({
    key: r.key,
    kind: r.kind,
    unitType: r.unit_type,
    salt: r.salt,
    variants: r.variants,
    defaultVariant: r.default_variant,
    status: r.status,
    version: r.version,
    rules: r.rules,
    fallthrough: r.fallthrough,
    allocation: r.allocation,
  }))
}

/** Must run inside the transaction that changed the environment's flags. */
export async function compileAndStore(client: pg.PoolClient, environment: string, reason: string): Promise<CompiledSnapshot> {
  const end = snapshotCompiles.startTimer({ environment })
  const bumped = await client.query<{ snapshot_version: string }>(
    'UPDATE environments SET snapshot_version = snapshot_version + 1, updated_at = now() WHERE key = $1 RETURNING snapshot_version',
    [environment],
  )
  if (bumped.rowCount === 0) throw new Error(`unknown environment ${environment}`)
  const version = Number(bumped.rows[0].snapshot_version)
  const body = compileSnapshot(environment, version, await loadCompilable(client, environment))
  const json = JSON.stringify(body)
  const etag = snapshotEtag(environment, version)
  await client.query(
    'INSERT INTO snapshots (environment, version, etag, body, flag_count, bytes, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [environment, version, etag, json, Object.keys(body.flags).length, Buffer.byteLength(json), reason],
  )
  end()
  return { environment, version, etag, body, json }
}

/** Forward-only: an older snapshot never overwrites a newer one, whatever order publishers finish in. */
const SET_LATEST = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[2])
  return 1
end
return 0`

const latestVersionKey = (env: string) => `${keys.snapshotLatest(env)}:version`

/** After commit. Best effort: if Valkey is down, the reconcile loop still finds the new version in PostgreSQL. */
export async function publishSnapshot(snap: CompiledSnapshot, reason: string): Promise<void> {
  const notice: SnapshotNotice = {
    environment: snap.environment,
    version: snap.version,
    etag: snap.etag,
    reason,
    publishedAt: Date.now(),
    origin: config.instanceId,
  }
  remember(snap, notice)
  try {
    await redis.eval(SET_LATEST, 2, latestVersionKey(snap.environment), keys.snapshotLatest(snap.environment), String(snap.version), snap.json)
    await redis.set(keys.snapshotPublishedAt(snap.environment, snap.version), JSON.stringify({ at: notice.publishedAt, reason }), 'EX', 86_400)
    await redis.publish(keys.snapshotChannel, JSON.stringify(notice))
  } catch (err) {
    logger.warn({ err: (err as Error).message, environment: snap.environment, version: snap.version }, 'snapshot publish failed; reconcile will catch up')
  }
}

function remember(snap: CompiledSnapshot, notice: SnapshotNotice | null): void {
  recent.set(`${snap.environment}:${snap.version}`, snap)
  if (recent.size > 50) recent.delete(recent.keys().next().value as string)
  const current = latest.get(snap.environment)
  if (current && current.version >= snap.version) return
  latest.set(snap.environment, snap)
  snapshotVersion.set({ environment: snap.environment }, snap.version)
  if (notice) for (const listener of listeners) listener(snap, notice)
}

function fromBody(environment: string, version: number, body: Snapshot): CompiledSnapshot {
  return { environment, version, etag: snapshotEtag(environment, version), body, json: JSON.stringify(body) }
}

async function loadVersionFromDb(environment: string, version: number | null): Promise<CompiledSnapshot | null> {
  const { rows } =
    version === null
      ? await pool.query<{ version: string; body: Snapshot }>('SELECT version, body FROM snapshots WHERE environment = $1 ORDER BY version DESC LIMIT 1', [environment])
      : await pool.query<{ version: string; body: Snapshot }>('SELECT version, body FROM snapshots WHERE environment = $1 AND version = $2', [environment, version])
  if (rows.length === 0) return null
  return fromBody(environment, Number(rows[0].version), rows[0].body)
}

async function loadLatestFromCache(environment: string): Promise<CompiledSnapshot | null> {
  try {
    const raw = await redis.get(keys.snapshotLatest(environment))
    if (!raw) return null
    const body = JSON.parse(raw) as Snapshot
    return { environment, version: body.version, etag: snapshotEtag(environment, body.version), body, json: raw }
  } catch {
    return null
  }
}

/** The newest snapshot this instance knows; loads it on first use (Valkey, then PostgreSQL). */
export async function getLatest(environment: string): Promise<CompiledSnapshot | null> {
  const cached = latest.get(environment)
  if (cached) return cached
  snapshotReloads.inc({ trigger: 'cold' })
  const loaded = (await loadLatestFromCache(environment)) ?? (await loadVersionFromDb(environment, null))
  if (loaded) remember(loaded, null)
  return latest.get(environment) ?? null
}

/** A specific (immutable) version: what a client fetches after a push names it. */
export async function getByVersion(environment: string, version: number): Promise<CompiledSnapshot | null> {
  const hit = recent.get(`${environment}:${version}`)
  if (hit) return hit
  const cached = latest.get(environment)
  if (cached?.version === version) return cached
  snapshotReloads.inc({ trigger: 'by_version' })
  const fromCache = await loadLatestFromCache(environment)
  const loaded = fromCache?.version === version ? fromCache : await loadVersionFromDb(environment, version)
  if (loaded) remember(loaded, null)
  return loaded
}

/** Called with every snapshot newer than the one in memory, from any source. */
export function onSnapshot(listener: (snap: CompiledSnapshot, notice: SnapshotNotice) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function handleNotice(notice: SnapshotNotice, trigger: 'pubsub' | 'reconcile'): Promise<void> {
  const current = latest.get(notice.environment)
  if (current && current.version >= notice.version) return
  snapshotReloads.inc({ trigger })
  const fromCache = await loadLatestFromCache(notice.environment)
  const loaded = fromCache && fromCache.version >= notice.version ? fromCache : await loadVersionFromDb(notice.environment, notice.version)
  if (!loaded) return
  remember(loaded, { ...notice, version: loaded.version, etag: loaded.etag })
}

let subscriber: Redis | null = null
let reconcileTimer: NodeJS.Timeout | null = null

export async function reconcileOnce(): Promise<void> {
  const { rows } = await pool.query<{ key: string; snapshot_version: string }>('SELECT key, snapshot_version FROM environments')
  for (const row of rows) {
    const version = Number(row.snapshot_version)
    const current = latest.get(row.key)
    if (version > 0 && (!current || current.version < version)) {
      const meta = await redis
        .get(keys.snapshotPublishedAt(row.key, version))
        .then((raw) => (raw ? (JSON.parse(raw) as { at: number; reason: string }) : null))
        .catch(() => null)
      await handleNotice(
        { environment: row.key, version, etag: snapshotEtag(row.key, version), reason: meta?.reason ?? 'reconcile', publishedAt: meta?.at ?? Date.now(), origin: 'reconcile' },
        'reconcile',
      )
    }
  }
}

export function startSnapshotSync(): void {
  if (subscriber) return
  subscriber = createRedisConnection('snapshot-subscriber')
  subscriber.subscribe(keys.snapshotChannel).catch((err) => logger.error({ err: err.message }, 'snapshot subscribe failed'))
  subscriber.on('message', (_channel: string, raw: string) => {
    let notice: SnapshotNotice
    try {
      notice = JSON.parse(raw) as SnapshotNotice
    } catch {
      return
    }
    handleNotice(notice, 'pubsub').catch((err) => logger.warn({ err: (err as Error).message }, 'snapshot reload failed'))
  })
  reconcileTimer = setInterval(() => {
    reconcileOnce().catch((err) => logger.warn({ err: (err as Error).message }, 'snapshot reconcile failed'))
  }, config.snapshotReconcileMs)
  reconcileTimer.unref()
}

export function stopSnapshotSync(): void {
  subscriber?.disconnect()
  subscriber = null
  if (reconcileTimer) clearInterval(reconcileTimer)
  reconcileTimer = null
}

/** Recent snapshot history for the console. */
export async function listSnapshots(environment: string, limit = 20) {
  const { rows } = await pool.query<{ version: string; etag: string; flag_count: number; bytes: number; reason: string; created_at: Date }>(
    'SELECT version, etag, flag_count, bytes, reason, created_at FROM snapshots WHERE environment = $1 ORDER BY version DESC LIMIT $2',
    [environment, limit],
  )
  return rows.map((r) => ({ version: Number(r.version), etag: r.etag, flagCount: r.flag_count, bytes: r.bytes, reason: r.reason, createdAt: r.created_at.toISOString() }))
}
