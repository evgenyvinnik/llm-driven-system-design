/**
 * Organization policy: org defaults and enforcement, one key at a time.
 * Same concurrency contract as user settings: an org policy revision, a
 * per-key changed-at revision, and If-Match on writes.
 * @module services/policy-service
 */
import type { SessionUser } from '../shared/auth.js'
import { pool, withTransaction } from '../shared/db.js'
import { HttpError } from '../shared/errors.js'
import { publishEvent } from '../shared/events.js'
import { policyChanges } from '../shared/metrics.js'
import { planOrgChange, type BaseRevision, type OrgPolicyInput } from '../domain/patch.js'
import { keyStatus } from '../domain/resolve.js'
import type { Definition, KeyStatus, SettingValue } from '../domain/types.js'
import { getCatalog, getCatalogFor } from './catalog.js'
import { jsonb, loadOrgRevision, loadOrgRows } from './rows.js'

export interface PolicyItem {
  key: string
  status: KeyStatus
  value: SettingValue | null
  enforced: boolean
  rev: number
  updatedAt: string | null
  /** Members of this org who have their own value for the key (what an enforcement would shadow). */
  overrideCount: number
}

export interface OrgPolicy {
  orgId: string
  orgName: string
  orgRevision: number
  catalogRevision: number
  memberCount: number
  items: PolicyItem[]
}

export async function getOrgPolicy(admin: SessionUser): Promise<OrgPolicy> {
  const catalog = await getCatalog()
  const [orgRevision, orgRows, counts, members] = await Promise.all([
    loadOrgRevision(pool, admin.orgId),
    loadOrgRows(pool, admin.orgId),
    pool.query<{ key: string; n: string }>(
      `SELECT us.key, count(*) AS n FROM user_settings us JOIN users u ON u.id = us.user_id
        WHERE u.org_id = $1 AND us.value IS NOT NULL GROUP BY us.key`,
      [admin.orgId],
    ),
    pool.query<{ n: string }>('SELECT count(*) AS n FROM users WHERE org_id = $1', [admin.orgId]),
  ])
  const countByKey = new Map(counts.rows.map((r) => [r.key, Number(r.n)]))
  const now = new Date()
  const items: PolicyItem[] = []
  for (const def of catalog.list) {
    const status = keyStatus(def, now)
    if (status === 'retired') continue
    const row = orgRows.get(def.key)
    items.push({
      key: def.key,
      status,
      value: row?.value ?? null,
      enforced: row && row.value !== null ? row.enforced : false,
      rev: row?.rev ?? 0,
      updatedAt: row ? row.updatedAt.toISOString() : null,
      overrideCount: countByKey.get(def.key) ?? 0,
    })
  }
  return {
    orgId: admin.orgId,
    orgName: admin.orgName,
    orgRevision,
    catalogRevision: catalog.revision,
    memberCount: Number(members.rows[0]?.n ?? 0),
    items,
  }
}

export interface PolicyWriteResult {
  orgRevision: number
  changed: boolean
  item: { key: string; value: SettingValue | null; enforced: boolean; rev: number }
}

export async function setOrgPolicy(
  admin: SessionUser,
  key: string,
  baseRevision: BaseRevision,
  next: OrgPolicyInput | null,
): Promise<PolicyWriteResult> {
  const catalog = await getCatalogFor([key])
  const def: Definition | undefined = catalog.defs.get(key)

  const result = await withTransaction(async (client) => {
    const revision = await loadOrgRevision(client, admin.orgId, true)
    if (baseRevision !== '*' && baseRevision > revision) {
      throw new HttpError(412, 'PRECONDITION_FAILED', `If-Match revision ${baseRevision} is ahead of the server (${revision}); refetch`)
    }
    const orgRows = await loadOrgRows(client, admin.orgId)
    const current = orgRows.get(key)
    const plan = planOrgChange(def, key, current, baseRevision, next, new Date())
    if (plan.kind === 'invalid') {
      policyChanges.inc({ outcome: 'invalid' })
      throw new HttpError(422, 'VALIDATION_FAILED', plan.error.message, { fields: [plan.error] })
    }
    if (plan.kind === 'conflict') {
      policyChanges.inc({ outcome: 'conflict' })
      throw new HttpError(409, 'CONFLICT', 'Another admin changed this policy after your base revision', {
        conflicts: [{ key, baseRevision, changedAtRevision: plan.changedAtRevision }],
        current: { orgRevision: revision, value: current?.value ?? null, enforced: current?.enforced ?? false, rev: current?.rev ?? 0 },
      })
    }
    if (plan.kind === 'unchanged') {
      policyChanges.inc({ outcome: 'noop' })
      return {
        orgRevision: revision,
        changed: false,
        item: { key, value: current?.value ?? null, enforced: current?.enforced ?? false, rev: current?.rev ?? 0 },
      }
    }
    const nextRev = revision + 1
    await client.query('UPDATE organizations SET policy_revision = $2 WHERE id = $1', [admin.orgId, nextRev])
    await client.query(
      `INSERT INTO org_settings (org_id, key, value, enforced, rev, updated_at, updated_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, now(), $6)
       ON CONFLICT (org_id, key) DO UPDATE
         SET value = EXCLUDED.value, enforced = EXCLUDED.enforced, rev = EXCLUDED.rev, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [admin.orgId, key, jsonb(plan.value), plan.enforced, nextRev, admin.id],
    )
    await client.query(
      `INSERT INTO setting_changes (scope, org_id, key, old_value, new_value, enforced, revision, actor_id, client_label)
       VALUES ('org', $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, 'admin console')`,
      [admin.orgId, key, jsonb(plan.previous?.value ?? null), jsonb(plan.value), plan.enforced, nextRev, admin.id],
    )
    policyChanges.inc({ outcome: 'applied' })
    return { orgRevision: nextRev, changed: true, item: { key, value: plan.value, enforced: plan.enforced, rev: nextRev } }
  })

  if (result.changed) await publishEvent({ type: 'org', orgId: admin.orgId, orgRevision: result.orgRevision, keys: [key] })
  return result
}

export async function getOrgHistory(admin: SessionUser, limit = 25) {
  const { rows } = await pool.query<{
    id: string
    scope: string
    key: string
    old_value: unknown
    new_value: unknown
    enforced: boolean | null
    revision: string
    actor: string | null
    client_label: string | null
    created_at: Date
  }>(
    `SELECT c.id, c.scope, c.key, c.old_value, c.new_value, c.enforced, c.revision, u.display_name AS actor, c.client_label, c.created_at
       FROM setting_changes c LEFT JOIN users u ON u.id = c.actor_id
      WHERE (c.org_id = $1 AND c.scope = 'org') OR c.scope = 'catalog'
      ORDER BY c.id DESC LIMIT $2`,
    [admin.orgId, limit],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    scope: r.scope,
    key: r.key,
    oldValue: r.old_value,
    newValue: r.new_value,
    enforced: r.enforced,
    revision: Number(r.revision),
    actor: r.actor,
    clientLabel: r.client_label,
    at: r.created_at.toISOString(),
  }))
}
