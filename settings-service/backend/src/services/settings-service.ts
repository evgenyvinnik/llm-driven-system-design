/**
 * Reading and writing one user's settings.
 *
 * Read: the user's revision, org policy and user rows come from one
 * REPEATABLE READ snapshot, so the revision a client stores always matches the
 * values it received.
 *
 * Write: the user's row is locked (`FOR UPDATE`) for the few milliseconds the
 * transaction takes, which serialises that user's writers. Different keys
 * still both succeed, because the conflict check is per key (domain/patch).
 * The change log row is written in the same transaction; the SSE event is
 * published after commit.
 * @module services/settings-service
 */
import type { PoolClient } from 'pg'
import type { SessionUser } from '../shared/auth.js'
import { pool, withTransaction } from '../shared/db.js'
import { HttpError } from '../shared/errors.js'
import { publishEvent } from '../shared/events.js'
import { patchKeys, patchOutcomes } from '../shared/metrics.js'
import { planUserPatch, type BaseRevision } from '../domain/patch.js'
import { resolveAll } from '../domain/resolve.js'
import type { EffectiveEntry, OrgValue, PatchWarning, UserValue } from '../domain/types.js'
import { getCatalog, getCatalogFor, type Catalog } from './catalog.js'
import { jsonb, loadOrgRevision, loadOrgRows, loadUserRevision, loadUserRows } from './rows.js'

export interface EffectiveDoc {
  revision: number
  orgRevision: number
  catalogRevision: number
  settings: Record<string, EffectiveEntry>
}

export interface PatchResult extends EffectiveDoc {
  applied: string[]
  unchanged: string[]
  warnings: PatchWarning[]
}

function buildDoc(catalog: Catalog, revision: number, orgRevision: number, orgRows: Map<string, OrgValue>, userRows: Map<string, UserValue>): EffectiveDoc {
  return {
    revision,
    orgRevision,
    catalogRevision: catalog.revision,
    settings: resolveAll(catalog.list, orgRows, userRows, new Date()),
  }
}

async function snapshot(client: PoolClient, user: SessionUser, catalog: Catalog) {
  const revision = await loadUserRevision(client, user.id)
  const [orgRevision, orgRows, userRows] = await Promise.all([
    loadOrgRevision(client, user.orgId),
    loadOrgRows(client, user.orgId),
    loadUserRows(client, user.id),
  ])
  return buildDoc(catalog, revision, orgRevision, orgRows, userRows)
}

export async function getEffectiveDoc(user: SessionUser): Promise<EffectiveDoc> {
  const catalog = await getCatalog()
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const doc = await snapshot(client, user, catalog)
    await client.query('COMMIT')
    return doc
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/** Current revisions only, for the SSE hello (cheap: two primary-key reads). */
export async function getRevisions(user: SessionUser): Promise<{ revision: number; orgRevision: number; catalogRevision: number }> {
  const [revision, orgRevision, catalog] = await Promise.all([loadUserRevision(pool, user.id), loadOrgRevision(pool, user.orgId), getCatalog()])
  return { revision, orgRevision, catalogRevision: catalog.revision }
}

export interface PatchContext {
  baseRevision: BaseRevision
  clientId: string | null
  clientLabel: string | null
}

export async function applyUserPatch(user: SessionUser, patch: Record<string, unknown>, ctx: PatchContext): Promise<PatchResult> {
  // Reload the catalog (outside the transaction) if a key is unknown to this instance.
  const catalog = await getCatalogFor(Object.keys(patch))

  const result = await withTransaction(async (client) => {
    const revision = await loadUserRevision(client, user.id, true)
    if (ctx.baseRevision !== '*' && ctx.baseRevision > revision) {
      patchOutcomes.inc({ outcome: 'precondition' })
      const current = await snapshot(client, user, catalog)
      throw new HttpError(412, 'PRECONDITION_FAILED', `If-Match revision ${ctx.baseRevision} is ahead of the server (${revision}); refetch`, {
        current,
      })
    }
    const [orgRevision, orgRows, userRows] = await Promise.all([
      loadOrgRevision(client, user.orgId),
      loadOrgRows(client, user.orgId),
      loadUserRows(client, user.id),
    ])
    const plan = planUserPatch({ defs: catalog.defs, orgRows, userRows, baseRevision: ctx.baseRevision, patch, now: new Date() })

    if (plan.kind === 'invalid') {
      patchOutcomes.inc({ outcome: plan.errors.some((e) => e.code === 'LOCKED') ? 'locked' : 'invalid' })
      throw new HttpError(422, 'VALIDATION_FAILED', 'One or more settings were rejected; nothing was saved', {
        fields: plan.errors,
        warnings: plan.warnings,
      })
    }
    if (plan.kind === 'conflict') {
      patchOutcomes.inc({ outcome: 'conflict' })
      throw new HttpError(409, 'CONFLICT', 'Another device changed these settings after your base revision; nothing was saved', {
        conflicts: plan.conflicts,
        current: buildDoc(catalog, revision, orgRevision, orgRows, userRows),
      })
    }
    patchKeys.inc({ result: 'deprecated_ignored' }, plan.warnings.length)
    patchKeys.inc({ result: 'unchanged' }, plan.unchanged.length)
    if (plan.changes.length === 0) {
      patchOutcomes.inc({ outcome: 'noop' })
      return { doc: buildDoc(catalog, revision, orgRevision, orgRows, userRows), plan, changed: false }
    }

    const next = revision + 1
    await client.query('UPDATE users SET settings_revision = $2 WHERE id = $1', [user.id, next])
    const now = new Date()
    for (const c of plan.changes) {
      await client.query(
        `INSERT INTO user_settings (user_id, key, value, rev, updated_at, updated_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         ON CONFLICT (user_id, key) DO UPDATE
           SET value = EXCLUDED.value, rev = EXCLUDED.rev, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [user.id, c.key, jsonb(c.value), next, now, ctx.clientLabel],
      )
      await client.query(
        `INSERT INTO setting_changes (scope, org_id, user_id, key, old_value, new_value, revision, actor_id, client_label)
         VALUES ('user', $1, $2, $3, $4::jsonb, $5::jsonb, $6, $2, $7)`,
        [user.orgId, user.id, c.key, jsonb(c.previous), jsonb(c.value), next, ctx.clientLabel],
      )
      userRows.set(c.key, { key: c.key, value: c.value, rev: next, updatedAt: now, updatedBy: ctx.clientLabel })
    }
    patchOutcomes.inc({ outcome: 'applied' })
    patchKeys.inc({ result: 'changed' }, plan.changes.length)
    return { doc: buildDoc(catalog, next, orgRevision, orgRows, userRows), plan, changed: true }
  })

  const { doc, plan, changed } = result
  if (plan.kind !== 'ok') throw new Error('unreachable')
  const applied = plan.changes.map((c) => c.key)
  if (changed) {
    const changes: Record<string, EffectiveEntry> = {}
    for (const key of applied) if (doc.settings[key]) changes[key] = doc.settings[key]
    await publishEvent({
      type: 'user',
      userId: user.id,
      orgId: user.orgId,
      revision: doc.revision,
      orgRevision: doc.orgRevision,
      catalogRevision: doc.catalogRevision,
      changes,
      clientId: ctx.clientId,
      clientLabel: ctx.clientLabel,
    })
  }
  return { ...doc, applied, unchanged: plan.unchanged, warnings: plan.warnings }
}

export interface ChangeLogEntry {
  id: number
  scope: 'user' | 'org' | 'catalog'
  key: string
  oldValue: unknown
  newValue: unknown
  enforced: boolean | null
  revision: number
  actor: string | null
  clientLabel: string | null
  at: string
}

export async function getUserHistory(user: SessionUser, limit = 20): Promise<ChangeLogEntry[]> {
  const { rows } = await pool.query<{
    id: string
    scope: ChangeLogEntry['scope']
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
      WHERE c.user_id = $1 ORDER BY c.id DESC LIMIT $2`,
    [user.id, limit],
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
