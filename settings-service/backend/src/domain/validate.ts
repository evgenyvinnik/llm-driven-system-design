/**
 * Value validation against a definition (type, enum, range, length, format)
 * and validation of a new definition submitted at runtime.
 * @module domain/validate
 */
import { z } from 'zod'
import type { Definition, FieldError, SettingValue } from './types.js'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
export const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

const tzCache = new Map<string, boolean>()
export function isValidTimeZone(tz: string): boolean {
  const cached = tzCache.get(tz)
  if (cached !== undefined) return cached
  let ok: boolean
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    ok = tz.length <= 64
  } catch {
    ok = false
  }
  tzCache.set(tz, ok)
  return ok
}

type ValueRules = Pick<Definition, 'key' | 'type' | 'allowedValues' | 'minValue' | 'maxValue' | 'maxLength' | 'format'>

/** Returns null when `value` is acceptable for the definition, else one field error. */
export function validateValue(def: ValueRules, value: unknown): FieldError | null {
  const err = (code: FieldError['code'], message: string): FieldError => ({ key: def.key, code, message })
  switch (def.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : err('INVALID_TYPE', 'Expected true or false')
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return err('INVALID_TYPE', 'Expected an integer')
      if (def.minValue !== null && value < def.minValue) return err('OUT_OF_RANGE', `Must be at least ${def.minValue}`)
      if (def.maxValue !== null && value > def.maxValue) return err('OUT_OF_RANGE', `Must be at most ${def.maxValue}`)
      return null
    }
    case 'enum': {
      if (typeof value !== 'string') return err('INVALID_TYPE', 'Expected one of the listed options')
      const allowed = def.allowedValues ?? []
      return allowed.includes(value) ? null : err('NOT_ALLOWED', `Must be one of: ${allowed.join(', ')}`)
    }
    case 'string': {
      if (typeof value !== 'string') return err('INVALID_TYPE', 'Expected text')
      if (def.maxLength !== null && [...value].length > def.maxLength) return err('TOO_LONG', `At most ${def.maxLength} characters`)
      if (def.format === 'hhmm' && !HHMM.test(value)) return err('INVALID_FORMAT', 'Expected a 24-hour time such as 22:00')
      if (def.format === 'timezone' && !isValidTimeZone(value)) return err('INVALID_FORMAT', 'Expected an IANA time zone such as Europe/Berlin')
      return null
    }
  }
}

export const newDefinitionSchema = z
  .object({
    key: z.string().min(3).max(80).regex(KEY_PATTERN, 'Use dotted lower-case segments, e.g. notifications.weekly_report'),
    type: z.enum(['boolean', 'enum', 'integer', 'string']),
    scope: z.enum(['user', 'org']).default('user'),
    defaultValue: z.union([z.boolean(), z.number(), z.string()]),
    allowedValues: z.array(z.string().min(1).max(40)).min(2).max(20).nullable().optional(),
    minValue: z.number().int().nullable().optional(),
    maxValue: z.number().int().nullable().optional(),
    maxLength: z.number().int().min(1).max(1000).nullable().optional(),
    format: z.enum(['hhmm', 'timezone']).nullable().optional(),
    category: z.string().min(1).max(40),
    label: z.string().min(1).max(80),
    description: z.string().max(300).default(''),
  })
  .strict()

export type NewDefinitionInput = z.infer<typeof newDefinitionSchema>

/** Cross-field checks zod can't express: the rules must fit the type and the default must satisfy them. */
export function validateDefinitionRules(input: NewDefinitionInput): FieldError[] {
  const errors: FieldError[] = []
  const add = (field: string, message: string) => errors.push({ key: field, code: 'INVALID_FORMAT', message })
  if (input.type === 'enum') {
    if (!input.allowedValues) add('allowedValues', 'An enum needs at least two allowed values')
    else if (new Set(input.allowedValues).size !== input.allowedValues.length) add('allowedValues', 'Allowed values must be unique')
  } else if (input.allowedValues) add('allowedValues', 'Only enum settings take allowed values')
  if (input.type !== 'integer' && (input.minValue != null || input.maxValue != null)) add('minValue', 'Only integer settings take a range')
  if (input.minValue != null && input.maxValue != null && input.minValue > input.maxValue) add('maxValue', 'Maximum is below minimum')
  if (input.type !== 'string' && (input.maxLength != null || input.format != null)) add('maxLength', 'Only string settings take a length or format')
  if (errors.length > 0) return errors
  const defaultError = validateValue(
    {
      key: 'defaultValue',
      type: input.type,
      allowedValues: input.allowedValues ?? null,
      minValue: input.minValue ?? null,
      maxValue: input.maxValue ?? null,
      maxLength: input.maxLength ?? null,
      format: input.format ?? null,
    },
    input.defaultValue,
  )
  if (defaultError) errors.push({ ...defaultError, message: `Default is invalid: ${defaultError.message}` })
  return errors
}

export function isSettingValue(v: unknown): v is SettingValue {
  return typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string'
}
