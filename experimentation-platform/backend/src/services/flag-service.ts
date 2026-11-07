/**
 * Flags and experiments: reads, and every mutation as one transaction that
 * (1) locks the config row, (2) checks the expected version, (3) writes the
 * new config with version + 1, (4) appends the version history and the audit
 * entry, (5) compiles the environment's next snapshot. The snapshot is
 * published only after commit, so a client can never see a ruleset whose
 * change was rolled back.
 * @module services/flag-service
 */
import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import {
  canTransition,
  checkConfigReferences,
  defaultVariants,
  describeConfigChange,
  initialWeights,
  killTarget,
  TRANSITIONS,
  type createFlagSchema,
  type metadataSchema,
  type updateConfigSchema,
} from '../domain/flag-model.js'
import { pool, withTransaction } from '../shared/db.js'
import { HttpError, notFound } from '../shared/errors.js'
import {
  allocateStable,
  compareAllocations,
  weightsOf,
  type Allocation,
  type FlagKind,
  type FlagStatus,
  type MoveSummary,
  type TargetingRule,
  type UnitType,
  type VariantDef,
} from '../shared/evaluation.js'
import type { z } from 'zod'
import { compileAndStore, publishSnapshot, type CompiledSnapshot } from './snapshot-service.js'

export interface Actor {
  id: string
  username: string
}

export interface FlagConfigDTO {
  environment: string
  status: FlagStatus
  version: number
  allocation: Allocation
  weights: Record<string, number>
  rules: TargetingRule[]
  fallthrough: 'enroll' | 'exclude'
  allowedTransitions: FlagStatus[]
  startedAt: string | null
  stoppedAt: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface FlagDTO {
  id: string
  key: string
  kind: FlagKind
  name: string
  description: string
  unitType: UnitType
  salt: string
  variants: VariantDef[]
  defaultVariant: string
  primaryMetric: string
  attributionWindowHours: number
  surface: string
  createdAt: string
  updatedAt: string
  configs: Record<string, FlagConfigDTO>
}

interface FlagRow {
  id: string
  key: string
  kind: FlagKind
  name: string
  description: string
  unit_type: UnitType
  salt: string
  variants: VariantDef[]
  default_variant: string
  primary_metric: string
  attribution_window_hours: number
  surface: string
  created_at: Date
  updated_at: Date
}

interface ConfigRow {
  flag_id: string
  environment: string
  status: FlagStatus
  version: number
  allocation: Allocation
  rules: TargetingRule[]
  fallthrough: 'enroll' | 'exclude'
  started_at: Date | null
  stopped_at: Date | null
  updated_at: Date
  updated_by_name: string | null
}

function toConfigDTO(r: ConfigRow): FlagConfigDTO {
  return {
    environment: r.environment,
    status: r.status,
    version: r.version,
    allocation: r.allocation,
    weights: weightsOf(r.allocation),
    rules: r.rules,
    fallthrough: r.fallthrough,
    allowedTransitions: TRANSITIONS[r.status],
    startedAt: r.started_at?.toISOString() ?? null,
    stoppedAt: r.stopped_at?.toISOString() ?? null,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by_name,
  }
}

function toFlagDTO(f: FlagRow, configs: ConfigRow[]): FlagDTO {
  return {
    id: f.id,
    key: f.key,
    kind: f.kind,
    name: f.name,
    description: f.description,
    unitType: f.unit_type,
    salt: f.salt,
    variants: f.variants,
    defaultVariant: f.default_variant,
    primaryMetric: f.primary_metric,
    attributionWindowHours: f.attribution_window_hours,
    surface: f.surface,
    createdAt: f.created_at.toISOString(),
    updatedAt: f.updated_at.toISOString(),
    configs: Object.fromEntries(configs.filter((c) => c.flag_id === f.id).map((c) => [c.environment, toConfigDTO(c)])),
  }
}

const CONFIG_SELECT = `SELECT c.flag_id, c.environment, c.status, c.version, c.allocation, c.rules, c.fallthrough,
                              c.started_at, c.stopped_at, c.updated_at, u.username AS updated_by_name
                         FROM flag_configs c LEFT JOIN users u ON u.id = c.updated_by`

export async function listFlags(): Promise<FlagDTO[]> {
  const flags = await pool.query<FlagRow>('SELECT * FROM flags ORDER BY kind DESC, created_at')
  const configs = await pool.query<ConfigRow>(`${CONFIG_SELECT} ORDER BY c.environment`)
  return flags.rows.map((f) => toFlagDTO(f, configs.rows))
}

export async function getFlag(key: string, db: pg.Pool | pg.PoolClient = pool): Promise<FlagDTO> {
  const flags = await db.query<FlagRow>('SELECT * FROM flags WHERE key = $1', [key])
  const flag = flags.rows[0]
  if (!flag) throw notFound(`Flag ${key}`)
  const configs = await db.query<ConfigRow>(`${CONFIG_SELECT} WHERE c.flag_id = $1 ORDER BY c.environment`, [flag.id])
  return toFlagDTO(flag, configs.rows)
}

async function audit(
  client: pg.PoolClient,
  actor: Actor,
  entry: { action: string; flagKey: string; environment: string | null; fromVersion?: number | null; toVersion?: number | null; summary: string; details?: unknown },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, actor, action, flag_key, environment, from_version, to_version, summary, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actor.id, actor.username, entry.action, entry.flagKey, entry.environment, entry.fromVersion ?? null, entry.toVersion ?? null, entry.summary, JSON.stringify(entry.details ?? {})],
  )
}

async function recordVersion(client: pg.PoolClient, flagId: string, environment: string, actor: Actor): Promise<void> {
  await client.query(
    `INSERT INTO flag_versions (flag_id, environment, version, status, allocation, rules, fallthrough, changed_by)
     SELECT flag_id, environment, version, status, allocation, rules, fallthrough, $3 FROM flag_configs WHERE flag_id = $1 AND environment = $2`,
    [flagId, environment, actor.id],
  )
}

/** Locks one flag's config in one environment for the rest of the transaction. */
async function lockConfig(client: pg.PoolClient, key: string, environment: string) {
  const { rows } = await client.query<FlagRow & { status: FlagStatus; version: number; allocation: Allocation; rules: TargetingRule[]; fallthrough: 'enroll' | 'exclude'; started_at: Date | null }>(
    `SELECT f.*, c.status, c.version, c.allocation, c.rules, c.fallthrough, c.started_at
       FROM flags f JOIN flag_configs c ON c.flag_id = f.id
      WHERE f.key = $1 AND c.environment = $2
      FOR UPDATE OF c`,
    [key, environment],
  )
  if (!rows[0]) throw notFound(`Flag ${key} in ${environment}`)
  return rows[0]
}

function checkVersion(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new HttpError(409, 'VERSION_CONFLICT', `Someone else changed this config (now version ${actual}); reload and reapply`, { currentVersion: actual })
  }
}

export async function createFlag(actor: Actor, input: z.infer<typeof createFlagSchema>): Promise<FlagDTO> {
  const variants = input.variants ?? defaultVariants(input.kind)
  if (new Set(variants.map((v) => v.key)).size !== variants.length) throw new HttpError(422, 'DUPLICATE_VARIANT', 'Variant keys must be unique')
  if (input.kind === 'flag' && variants.length !== 2) throw new HttpError(422, 'FLAG_VARIANTS', 'A flag has exactly two variants: off (default) and on')
  const allocation = allocateStable({}, initialWeights(input.kind, variants))
  const compiled: CompiledSnapshot[] = []
  const key = await withTransaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM flags WHERE key = $1', [input.key])
    if (exists.rowCount) throw new HttpError(409, 'KEY_TAKEN', `A flag named ${input.key} already exists`)
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO flags (key, kind, name, description, unit_type, salt, variants, default_variant, primary_metric, attribution_window_hours, surface, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [input.key, input.kind, input.name, input.description, input.unitType, `${input.key}-${randomBytes(4).toString('hex')}`, JSON.stringify(variants), variants[0].key, input.primaryMetric, input.attributionWindowHours, input.surface, actor.id],
    )
    const flagId = rows[0].id
    const envs = await client.query<{ key: string }>('SELECT key FROM environments ORDER BY key')
    for (const env of envs.rows) {
      await client.query(
        `INSERT INTO flag_configs (flag_id, environment, status, allocation, rules, fallthrough, version, updated_by) VALUES ($1, $2, 'draft', $3, '[]', 'enroll', 1, $4)`,
        [flagId, env.key, JSON.stringify(allocation), actor.id],
      )
      await recordVersion(client, flagId, env.key, actor)
      await audit(client, actor, { action: 'create', flagKey: input.key, environment: env.key, toVersion: 1, summary: `created ${input.kind} (${variants.map((v) => v.key).join(' / ')}, unit: ${input.unitType}) as draft` })
      compiled.push(await compileAndStore(client, env.key, `create ${input.key}`))
    }
    return input.key
  })
  for (const snap of compiled) await publishSnapshot(snap, `create ${key}`)
  return getFlag(key)
}

export async function updateMetadata(actor: Actor, key: string, input: z.infer<typeof metadataSchema>): Promise<FlagDTO> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<FlagRow>(
      `UPDATE flags SET name = COALESCE($2, name), description = COALESCE($3, description), primary_metric = COALESCE($4, primary_metric),
              attribution_window_hours = COALESCE($5, attribution_window_hours), surface = COALESCE($6, surface), updated_at = now()
        WHERE key = $1 RETURNING *`,
      [key, input.name ?? null, input.description ?? null, input.primaryMetric ?? null, input.attributionWindowHours ?? null, input.surface ?? null],
    )
    if (!rows[0]) throw notFound(`Flag ${key}`)
    const fields = Object.keys(input)
    // Metadata is not part of the snapshot (SDKs don't need it), so no recompile.
    await audit(client, actor, { action: 'update_metadata', flagKey: key, environment: null, summary: `updated ${fields.join(', ') || 'nothing'}`, details: input })
  })
  return getFlag(key)
}

export interface ConfigChangeResult {
  flag: FlagDTO
  move: MoveSummary
  snapshotVersion: number
}

export async function updateConfig(
  actor: Actor,
  key: string,
  environment: string,
  expectedVersion: number | undefined,
  input: z.infer<typeof updateConfigSchema>,
): Promise<ConfigChangeResult> {
  let move!: MoveSummary
  const snap = await withTransaction(async (client) => {
    const row = await lockConfig(client, key, environment)
    checkVersion(expectedVersion, row.version)
    if (row.status === 'stopped') throw new HttpError(409, 'STOPPED', 'A stopped experiment is final; create a new one to rerun it')
    const problem = checkConfigReferences(row.variants, input.weights, input.rules)
    if (problem) throw new HttpError(422, 'INVALID_CONFIG', problem)
    if (row.kind === 'experiment' && input.weights && !(row.default_variant in input.weights)) {
      throw new HttpError(422, 'INVALID_CONFIG', `weights must include the control variant "${row.default_variant}"`)
    }
    let allocation = row.allocation
    if (input.weights) {
      try {
        allocation = allocateStable(row.allocation, input.weights)
      } catch (err) {
        throw new HttpError(422, 'INVALID_WEIGHTS', (err as Error).message)
      }
    }
    const rules = input.rules ?? row.rules
    const fallthrough = input.fallthrough ?? row.fallthrough
    const summary = describeConfigChange({ allocation: row.allocation, rules: row.rules, fallthrough: row.fallthrough }, { allocation, rules, fallthrough })
    move = compareAllocations(row.allocation, allocation)
    if (summary === 'no effective change') throw new HttpError(422, 'NO_CHANGE', 'Nothing to change')
    await client.query(
      `UPDATE flag_configs SET allocation = $3, rules = $4, fallthrough = $5, version = version + 1, updated_by = $6, updated_at = now()
        WHERE flag_id = $1 AND environment = $2`,
      [row.id, environment, JSON.stringify(allocation), JSON.stringify(rules), fallthrough, actor.id],
    )
    await recordVersion(client, row.id, environment, actor)
    await audit(client, actor, {
      action: 'update_config',
      flagKey: key,
      environment,
      fromVersion: row.version,
      toVersion: row.version + 1,
      summary,
      details: { weightsBefore: weightsOf(row.allocation), weightsAfter: weightsOf(allocation), moved: move.changed, switched: move.switched },
    })
    return compileAndStore(client, environment, `${key} v${row.version + 1}: config`)
  })
  await publishSnapshot(snap, `${key}: config`)
  return { flag: await getFlag(key), move, snapshotVersion: snap.version }
}

async function changeStatus(actor: Actor, key: string, environment: string, to: FlagStatus, opts: { reason?: string; expectedVersion?: number; kill?: boolean }) {
  const snap = await withTransaction(async (client) => {
    const row = await lockConfig(client, key, environment)
    checkVersion(opts.expectedVersion, row.version)
    if (row.status === to) throw new HttpError(409, 'ALREADY', `Already ${to}`)
    if (!canTransition(row.status, to)) throw new HttpError(409, 'INVALID_TRANSITION', `Cannot go from ${row.status} to ${to} (allowed: ${TRANSITIONS[row.status].join(', ') || 'none'})`)
    await client.query(
      `UPDATE flag_configs SET status = $3, version = version + 1, updated_by = $4, updated_at = now(),
              started_at = CASE WHEN $3 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
              stopped_at = CASE WHEN $3 = 'stopped' THEN now() ELSE stopped_at END
        WHERE flag_id = $1 AND environment = $2`,
      [row.id, environment, to, actor.id],
    )
    await recordVersion(client, row.id, environment, actor)
    const verb = opts.kill ? (row.kind === 'flag' ? 'KILL SWITCH: forced off' : 'KILL SWITCH: stopped') : `status ${row.status} → ${to}`
    await audit(client, actor, {
      action: opts.kill ? 'kill_switch' : 'status',
      flagKey: key,
      environment,
      fromVersion: row.version,
      toVersion: row.version + 1,
      summary: opts.reason ? `${verb} (${opts.reason})` : verb,
      details: { from: row.status, to, reason: opts.reason ?? null },
    })
    return compileAndStore(client, environment, opts.kill ? `KILL ${key}` : `${key} → ${to}`)
  })
  await publishSnapshot(snap, opts.kill ? 'kill_switch' : `${key}: ${to}`)
  return { flag: await getFlag(key), snapshotVersion: snap.version, publishedAt: Date.now() }
}

export function transitionStatus(actor: Actor, key: string, environment: string, to: FlagStatus, reason?: string, expectedVersion?: number) {
  return changeStatus(actor, key, environment, to, { reason, expectedVersion })
}

/** Force a flag off (paused, resumable) or stop an experiment (final). Every unit gets the default variant. */
export async function killSwitch(actor: Actor, key: string, environment: string, reason: string) {
  const flag = await getFlag(key)
  return changeStatus(actor, key, environment, killTarget(flag.kind), { reason, kill: true })
}

export async function listVersions(key: string, environment: string) {
  const { rows } = await pool.query<{ version: number; status: FlagStatus; allocation: Allocation; rules: TargetingRule[]; fallthrough: string; changed_at: Date; changed_by: string | null }>(
    `SELECT v.version, v.status, v.allocation, v.rules, v.fallthrough, v.changed_at, u.username AS changed_by
       FROM flag_versions v JOIN flags f ON f.id = v.flag_id LEFT JOIN users u ON u.id = v.changed_by
      WHERE f.key = $1 AND v.environment = $2 ORDER BY v.version DESC`,
    [key, environment],
  )
  return rows.map((r) => ({ version: r.version, status: r.status, weights: weightsOf(r.allocation), allocation: r.allocation, ruleCount: r.rules.length, fallthrough: r.fallthrough, changedAt: r.changed_at.toISOString(), changedBy: r.changed_by }))
}

/** Allocation of every config version, for the per-version SRM expectation. */
export async function allocationsByVersion(flagId: string, environment: string): Promise<Map<number, Allocation>> {
  const { rows } = await pool.query<{ version: number; allocation: Allocation }>('SELECT version, allocation FROM flag_versions WHERE flag_id = $1 AND environment = $2', [flagId, environment])
  return new Map(rows.map((r) => [r.version, r.allocation]))
}

export async function listAudit(filter: { flagKey?: string; environment?: string; limit: number }) {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.flagKey) {
    params.push(filter.flagKey)
    where.push(`flag_key = $${params.length}`)
  }
  if (filter.environment) {
    params.push(filter.environment)
    where.push(`(environment = $${params.length} OR environment IS NULL)`)
  }
  params.push(filter.limit)
  const { rows } = await pool.query<{ id: string; at: Date; actor: string; action: string; flag_key: string | null; environment: string | null; from_version: number | null; to_version: number | null; summary: string }>(
    `SELECT id, at, actor, action, flag_key, environment, from_version, to_version, summary FROM audit_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
    params,
  )
  return rows.map((r) => ({ id: Number(r.id), at: r.at.toISOString(), actor: r.actor, action: r.action, flagKey: r.flag_key, environment: r.environment, fromVersion: r.from_version, toVersion: r.to_version, summary: r.summary }))
}
