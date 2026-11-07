/**
 * Row loading and mapping. Handlers never see raw rows: everything is mapped
 * to camelCase domain objects here.
 * @module services/rows
 */
import type { Queryable } from '../shared/db.js'
import type { Definition, OrgValue, SettingValue, UserValue } from '../domain/types.js'

interface DefinitionRow {
  key: string
  type: Definition['type']
  scope: Definition['scope']
  default_value: SettingValue
  allowed_values: string[] | null
  min_value: number | null
  max_value: number | null
  max_length: number | null
  format: Definition['format']
  category: string
  label: string
  description: string
  display_order: number
  deprecated_at: Date | null
  sunset_at: Date | null
  replaced_by: string | null
  catalog_rev: string
}

export const DEFINITION_COLUMNS = `key, type, scope, default_value, allowed_values, min_value, max_value, max_length, format,
  category, label, description, display_order, deprecated_at, sunset_at, replaced_by, catalog_rev`

export function mapDefinition(r: DefinitionRow): Definition {
  return {
    key: r.key,
    type: r.type,
    scope: r.scope,
    defaultValue: r.default_value,
    allowedValues: r.allowed_values,
    minValue: r.min_value,
    maxValue: r.max_value,
    maxLength: r.max_length,
    format: r.format,
    category: r.category,
    label: r.label,
    description: r.description,
    displayOrder: r.display_order,
    deprecatedAt: r.deprecated_at,
    sunsetAt: r.sunset_at,
    replacedBy: r.replaced_by,
    catalogRev: Number(r.catalog_rev),
  }
}

export async function loadDefinitions(q: Queryable): Promise<{ revision: number; defs: Definition[] }> {
  const [rev, defs] = await Promise.all([
    q.query<{ revision: string }>('SELECT revision FROM catalog_state WHERE id'),
    q.query<DefinitionRow>(`SELECT ${DEFINITION_COLUMNS} FROM setting_definitions ORDER BY category, display_order, key`),
  ])
  return { revision: Number(rev.rows[0]?.revision ?? 0), defs: defs.rows.map(mapDefinition) }
}

export async function loadOrgRows(q: Queryable, orgId: string): Promise<Map<string, OrgValue>> {
  const { rows } = await q.query<{ key: string; value: SettingValue | null; enforced: boolean; rev: string; updated_at: Date }>(
    'SELECT key, value, enforced, rev, updated_at FROM org_settings WHERE org_id = $1',
    [orgId],
  )
  return new Map(rows.map((r) => [r.key, { key: r.key, value: r.value, enforced: r.enforced, rev: Number(r.rev), updatedAt: r.updated_at }]))
}

export async function loadUserRows(q: Queryable, userId: string): Promise<Map<string, UserValue>> {
  const { rows } = await q.query<{ key: string; value: SettingValue | null; rev: string; updated_at: Date; updated_by: string | null }>(
    'SELECT key, value, rev, updated_at, updated_by FROM user_settings WHERE user_id = $1',
    [userId],
  )
  return new Map(
    rows.map((r) => [r.key, { key: r.key, value: r.value, rev: Number(r.rev), updatedAt: r.updated_at, updatedBy: r.updated_by }]),
  )
}

export async function loadOrgRevision(q: Queryable, orgId: string, forUpdate = false): Promise<number> {
  const { rows } = await q.query<{ policy_revision: string }>(
    `SELECT policy_revision FROM organizations WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [orgId],
  )
  return Number(rows[0]?.policy_revision ?? 0)
}

export async function loadUserRevision(q: Queryable, userId: string, forUpdate = false): Promise<number> {
  const { rows } = await q.query<{ settings_revision: string }>(
    `SELECT settings_revision FROM users WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId],
  )
  return Number(rows[0]?.settings_revision ?? 0)
}

/** JSONB parameter: pg serialises JS strings as text, so values go through JSON.stringify explicitly. */
export const jsonb = (v: SettingValue | null): string | null => (v === null ? null : JSON.stringify(v))
