/**
 * The global catalog: listing definitions, adding one at runtime, deprecating
 * one with a grace window. Adding a definition writes one row and bumps the
 * catalog revision; no user rows are touched, because users store only their
 * explicit choices and everyone else resolves to the new default.
 * @module services/catalog-service
 */
import type { SessionUser } from '../shared/auth.js'
import { config } from '../shared/config.js'
import { withTransaction } from '../shared/db.js'
import { HttpError } from '../shared/errors.js'
import { publishEvent } from '../shared/events.js'
import { keyStatus } from '../domain/resolve.js'
import type { Definition, KeyStatus, SettingValue } from '../domain/types.js'
import { validateDefinitionRules, type NewDefinitionInput } from '../domain/validate.js'
import { getCatalog, invalidateCatalog } from './catalog.js'
import { DEFINITION_COLUMNS, mapDefinition } from './rows.js'

export interface DefinitionDto {
  key: string
  type: Definition['type']
  scope: Definition['scope']
  defaultValue: SettingValue
  allowedValues: string[] | null
  minValue: number | null
  maxValue: number | null
  maxLength: number | null
  format: Definition['format']
  category: string
  label: string
  description: string
  displayOrder: number
  status: KeyStatus
  deprecatedAt: string | null
  sunsetAt: string | null
  replacedBy: string | null
}

export function toDefinitionDto(d: Definition, now = new Date()): DefinitionDto {
  return {
    key: d.key,
    type: d.type,
    scope: d.scope,
    defaultValue: d.defaultValue,
    allowedValues: d.allowedValues,
    minValue: d.minValue,
    maxValue: d.maxValue,
    maxLength: d.maxLength,
    format: d.format,
    category: d.category,
    label: d.label,
    description: d.description,
    displayOrder: d.displayOrder,
    status: keyStatus(d, now),
    deprecatedAt: d.deprecatedAt ? d.deprecatedAt.toISOString() : null,
    sunsetAt: d.sunsetAt ? d.sunsetAt.toISOString() : null,
    replacedBy: d.replacedBy,
  }
}

/** Definitions a client should know about. Retired keys are only listed for admins. */
export async function listDefinitions(includeRetired: boolean): Promise<{ catalogRevision: number; definitions: DefinitionDto[] }> {
  const catalog = await getCatalog()
  const now = new Date()
  const definitions = catalog.list.map((d) => toDefinitionDto(d, now)).filter((d) => includeRetired || d.status !== 'retired')
  return { catalogRevision: catalog.revision, definitions }
}

async function bumpCatalog(client: import('pg').PoolClient): Promise<number> {
  const { rows } = await client.query<{ revision: string }>('UPDATE catalog_state SET revision = revision + 1 WHERE id RETURNING revision')
  return Number(rows[0].revision)
}

export async function createDefinition(actor: SessionUser, input: NewDefinitionInput): Promise<DefinitionDto> {
  const ruleErrors = validateDefinitionRules(input)
  if (ruleErrors.length > 0) throw new HttpError(422, 'VALIDATION_FAILED', 'The definition is invalid', { fields: ruleErrors })

  const { def, revision } = await withTransaction(async (client) => {
    const existing = await client.query<{ sunset_at: Date | null }>('SELECT sunset_at FROM setting_definitions WHERE key = $1', [input.key])
    if (existing.rows.length > 0) {
      // A retired key's name is never reused: old clients and stored rows still mean the old thing by it.
      const retired = existing.rows[0].sunset_at !== null
      throw new HttpError(409, retired ? 'KEY_RETIRED' : 'KEY_EXISTS', retired ? 'That key was retired and cannot be reused' : 'That key already exists', {
        fields: [{ key: 'key', code: retired ? 'RETIRED' : 'INVALID_FORMAT', message: retired ? 'Retired keys cannot be reused' : 'Already exists' }],
      })
    }
    const revision = await bumpCatalog(client)
    const { rows } = await client.query(
      `INSERT INTO setting_definitions (key, type, scope, default_value, allowed_values, min_value, max_value, max_length, format,
                                        category, label, description, display_order, catalog_rev)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12,
               (SELECT coalesce(max(display_order), 0) + 10 FROM setting_definitions WHERE category = $10), $13)
       RETURNING ${DEFINITION_COLUMNS}`,
      [
        input.key,
        input.type,
        input.scope,
        JSON.stringify(input.defaultValue),
        input.allowedValues ? JSON.stringify(input.allowedValues) : null,
        input.minValue ?? null,
        input.maxValue ?? null,
        input.maxLength ?? null,
        input.format ?? null,
        input.category,
        input.label,
        input.description,
        revision,
      ],
    )
    await client.query(
      `INSERT INTO setting_changes (scope, key, new_value, revision, actor_id, client_label) VALUES ('catalog', $1, $2::jsonb, $3, $4, 'catalog: added')`,
      [input.key, JSON.stringify(input.defaultValue), revision, actor.id],
    )
    return { def: mapDefinition(rows[0]), revision }
  })

  invalidateCatalog(revision)
  await publishEvent({ type: 'catalog', catalogRevision: revision, keys: [def.key] })
  return toDefinitionDto(def)
}

export async function deprecateDefinition(
  actor: SessionUser,
  key: string,
  opts: { graceDays?: number; replacedBy?: string | null },
): Promise<DefinitionDto> {
  const graceDays = opts.graceDays ?? config.defaultGraceDays
  const { def, revision } = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT ${DEFINITION_COLUMNS} FROM setting_definitions WHERE key = $1 FOR UPDATE`, [key])
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'No such setting')
    const current = mapDefinition(rows[0])
    if (current.deprecatedAt) throw new HttpError(409, 'ALREADY_DEPRECATED', 'This setting is already deprecated')
    if (opts.replacedBy) {
      if (opts.replacedBy === key) throw new HttpError(422, 'VALIDATION_FAILED', 'A key cannot replace itself', { fields: [{ key: 'replacedBy', code: 'INVALID_FORMAT', message: 'Cannot replace itself' }] })
      const target = await client.query<{ deprecated_at: Date | null }>('SELECT deprecated_at FROM setting_definitions WHERE key = $1', [opts.replacedBy])
      if (target.rows.length === 0 || target.rows[0].deprecated_at) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'The replacement must be an active setting', {
          fields: [{ key: 'replacedBy', code: 'UNKNOWN_KEY', message: 'Not an active setting' }],
        })
      }
    }
    const revision = await bumpCatalog(client)
    const updated = await client.query(
      `UPDATE setting_definitions
          SET deprecated_at = now(), sunset_at = now() + make_interval(days => $2::int), replaced_by = $3, catalog_rev = $4
        WHERE key = $1 RETURNING ${DEFINITION_COLUMNS}`,
      [key, graceDays, opts.replacedBy ?? null, revision],
    )
    await client.query(
      `INSERT INTO setting_changes (scope, key, revision, actor_id, client_label) VALUES ('catalog', $1, $2, $3, $4)`,
      [key, revision, actor.id, `catalog: deprecated, ${graceDays}-day grace`],
    )
    return { def: mapDefinition(updated.rows[0]), revision }
  })

  invalidateCatalog(revision)
  await publishEvent({ type: 'catalog', catalogRevision: revision, keys: [key] })
  return toDefinitionDto(def)
}
