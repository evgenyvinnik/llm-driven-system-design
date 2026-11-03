/**
 * Effective access for (user, org): role, permissions, flags, entitlements and
 * the projects the user can see. Reads go through a Valkey cache keyed by the
 * org's authz version; writes and sensitive reads always recompute from
 * PostgreSQL.
 *
 * Cache key: perm:{orgId}:{userId}:v{version}[:as-{role}]
 *  - A membership, role or flag change bumps orgs.authz_version in the same
 *    transaction, then mirrors it to Valkey (authz:ver:{orgId}). New lookups
 *    use the new key, so old entries are unreachable at once.
 *  - If the mirror write is lost, the next cache miss sees PostgreSQL's higher
 *    version and repairs it; until then the TTL bounds staleness.
 * @module shared/access
 */
import type pg from 'pg'
import { redis } from './cache.js'
import { config } from './config.js'
import { pool, type Queryable } from './db.js'
import { publishOrgEvent, type AuthzChangeReason } from './events.js'
import { logger } from './logger.js'
import { permissionCacheResults } from './metrics.js'
import { computeAccess, type ComputedAccess, type FlagRule, type Plan, type Role } from './permissions.js'

export interface OrgBranding {
  accent: string
  initials: string
}

export interface ProjectRef {
  id: string
  name: string
  restricted: boolean
}

export interface EffectiveAccess extends ComputedAccess {
  orgId: string
  orgName: string
  plan: Plan
  branding: OrgBranding
  userId: string
  projects: ProjectRef[]
  projectIds: string[]
  version: number
}

const versionKey = (orgId: string) => `authz:ver:${orgId}`
const accessKey = (orgId: string, userId: string, version: number, previewRole?: Role) =>
  `perm:${orgId}:${userId}:v${version}${previewRole ? `:as-${previewRole}` : ''}`

/** Moves the mirrored version forward only; a slow writer can't roll it back. */
const SET_IF_GREATER = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local proposed = tonumber(ARGV[1])
if proposed > current then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return proposed
end
return current`

const VERSION_TTL_SECONDS = 24 * 60 * 60

async function mirrorVersion(orgId: string, version: number): Promise<void> {
  await redis.eval(SET_IF_GREATER, 1, versionKey(orgId), String(version), String(VERSION_TTL_SECONDS))
}

async function cachedVersion(orgId: string): Promise<number | null> {
  const raw = await redis.get(versionKey(orgId))
  return raw === null ? null : Number(raw)
}

export async function computeFromDatabase(
  db: Queryable,
  userId: string,
  orgId: string,
  previewRole?: Role,
): Promise<EffectiveAccess | null> {
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.plan, o.branding, o.authz_version, m.role
       FROM orgs o
       JOIN org_memberships m ON m.org_id = o.id AND m.user_id = $2
      WHERE o.id = $1`,
    [orgId, userId],
  )
  const org = rows[0]
  if (!org) return null

  const role = org.role as Role
  // Preview narrows what an admin sees to another role's view of the projects too.
  const projectRole = role === 'admin' && previewRole ? previewRole : role
  const [projects, flags] = await Promise.all([
    db.query(
      `SELECT p.id, p.name, p.restricted
         FROM projects p
        WHERE p.org_id = $1
          AND (NOT p.restricted
               OR $3 = 'admin'
               OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id AND pm.user_id = $2))
        ORDER BY p.name`,
      [orgId, userId, projectRole],
    ),
    db.query(
      `SELECT f.key, f.default_enabled, r.enabled, r.roles
         FROM feature_flags f
         LEFT JOIN feature_flag_rules r ON r.flag_key = f.key AND r.org_id = $1
        ORDER BY f.key`,
      [orgId],
    ),
  ])

  const flagRules: FlagRule[] = flags.rows
    .filter((f) => f.enabled !== null)
    .map((f) => ({ flagKey: f.key, enabled: f.enabled, roles: f.roles ?? [] }))
  const computed = computeAccess({
    role,
    previewRole,
    plan: org.plan as Plan,
    flagDefinitions: flags.rows.map((f) => ({ key: f.key, defaultEnabled: f.default_enabled })),
    flagRules,
  })
  const projectRefs: ProjectRef[] = projects.rows.map((p) => ({ id: p.id, name: p.name, restricted: p.restricted }))
  return {
    ...computed,
    orgId: org.id,
    orgName: org.name,
    plan: org.plan,
    branding: org.branding,
    userId,
    projects: projectRefs,
    projectIds: projectRefs.map((p) => p.id),
    version: Number(org.authz_version),
  }
}

export interface LoadAccessOptions {
  /** Skip the cache and read PostgreSQL. Every write uses this. */
  authoritative?: boolean
  previewRole?: Role
}

export async function loadAccess(
  userId: string,
  orgId: string,
  opts: LoadAccessOptions = {},
): Promise<EffectiveAccess | null> {
  if (!opts.authoritative) {
    try {
      const version = await cachedVersion(orgId)
      if (version !== null) {
        const raw = await redis.get(accessKey(orgId, userId, version, opts.previewRole))
        if (raw) {
          permissionCacheResults.inc({ result: 'hit' })
          return JSON.parse(raw) as EffectiveAccess
        }
      }
    } catch (err) {
      // Valkey down: fall through to PostgreSQL rather than fail the read.
      logger.warn({ err: (err as Error).message }, 'permission cache read failed')
    }
    permissionCacheResults.inc({ result: 'miss' })
  } else {
    permissionCacheResults.inc({ result: 'authoritative' })
  }

  const access = await computeFromDatabase(pool, userId, orgId, opts.previewRole)
  if (access) {
    try {
      await mirrorVersion(orgId, access.version)
      await redis.set(
        accessKey(orgId, userId, access.version, opts.previewRole),
        JSON.stringify(access),
        'EX',
        config.permissionCacheTtlSeconds,
      )
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'permission cache write failed')
    }
  }
  return access
}

/** Call inside the transaction that changes memberships, roles, project access or flags. */
export async function bumpAuthzVersion(client: pg.PoolClient, orgId: string): Promise<number> {
  const { rows } = await client.query(
    'UPDATE orgs SET authz_version = authz_version + 1 WHERE id = $1 RETURNING authz_version',
    [orgId],
  )
  return Number(rows[0].authz_version)
}

/** Call after the transaction commits: mirrors the version and tells connected members. */
export async function announceAuthzChange(orgId: string, version: number, reason: AuthzChangeReason): Promise<void> {
  try {
    await mirrorVersion(orgId, version)
  } catch (err) {
    logger.warn({ err: (err as Error).message, orgId }, 'authz version mirror failed; TTL bounds staleness')
  }
  await publishOrgEvent({ type: 'authz.changed', orgId, version, reason })
}
