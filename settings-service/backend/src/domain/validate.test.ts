import { describe, expect, it } from 'vitest'
import { DEFS } from './fixtures.js'
import { isValidTimeZone, validateDefinitionRules, validateValue } from './validate.js'

const d = (key: string) => DEFS.get(key)!

describe('validateValue', () => {
  it('checks booleans strictly (no "true" strings, no 0/1)', () => {
    expect(validateValue(d('privacy.read_receipts'), true)).toBeNull()
    expect(validateValue(d('privacy.read_receipts'), 'true')?.code).toBe('INVALID_TYPE')
    expect(validateValue(d('privacy.read_receipts'), 1)?.code).toBe('INVALID_TYPE')
  })

  it('checks enum membership', () => {
    expect(validateValue(d('appearance.theme'), 'dark')).toBeNull()
    const e = validateValue(d('appearance.theme'), 'purple')
    expect(e).toMatchObject({ key: 'appearance.theme', code: 'NOT_ALLOWED' })
    expect(e?.message).toContain('system, light, dark')
    expect(validateValue(d('appearance.theme'), 3)?.code).toBe('INVALID_TYPE')
  })

  it('checks integer type and range, inclusive', () => {
    expect(validateValue(d('appearance.font_scale'), 80)).toBeNull()
    expect(validateValue(d('appearance.font_scale'), 150)).toBeNull()
    expect(validateValue(d('appearance.font_scale'), 79)?.code).toBe('OUT_OF_RANGE')
    expect(validateValue(d('appearance.font_scale'), 151)?.code).toBe('OUT_OF_RANGE')
    expect(validateValue(d('appearance.font_scale'), 100.5)?.code).toBe('INVALID_TYPE')
    expect(validateValue(d('appearance.font_scale'), '100')?.code).toBe('INVALID_TYPE')
  })

  it('checks string length in characters, not bytes', () => {
    expect(validateValue(d('profile.status_message'), 'ÄÖÜ😀😀😀😀😀😀😀')).toBeNull()
    expect(validateValue(d('profile.status_message'), '12345678901')?.code).toBe('TOO_LONG')
  })

  it('checks formats: 24-hour time and IANA time zone', () => {
    expect(validateValue(d('notifications.quiet_hours_start'), '23:30')).toBeNull()
    expect(validateValue(d('notifications.quiet_hours_start'), '24:00')?.code).toBe('INVALID_FORMAT')
    expect(validateValue(d('notifications.quiet_hours_start'), '7:00')?.code).toBe('INVALID_FORMAT')
    expect(validateValue(d('regional.time_zone'), 'Europe/Berlin')).toBeNull()
    expect(validateValue(d('regional.time_zone'), 'Mars/Olympus_Mons')?.code).toBe('INVALID_FORMAT')
    expect(isValidTimeZone('America/New_York')).toBe(true)
  })

  it('rejects objects and arrays for every type', () => {
    for (const key of ['privacy.read_receipts', 'appearance.theme', 'appearance.font_scale', 'profile.status_message']) {
      expect(validateValue(d(key), { a: 1 })?.code).toBe('INVALID_TYPE')
      expect(validateValue(d(key), [1])?.code).toBe('INVALID_TYPE')
    }
  })
})

describe('validateDefinitionRules', () => {
  const base = { key: 'notifications.weekly_report', scope: 'user' as const, category: 'notifications', label: 'Weekly report', description: '' }

  it('accepts a well-formed definition of each type', () => {
    expect(validateDefinitionRules({ ...base, type: 'boolean', defaultValue: true })).toEqual([])
    expect(validateDefinitionRules({ ...base, type: 'enum', defaultValue: 'a', allowedValues: ['a', 'b'] })).toEqual([])
    expect(validateDefinitionRules({ ...base, type: 'integer', defaultValue: 5, minValue: 1, maxValue: 10 })).toEqual([])
    expect(validateDefinitionRules({ ...base, type: 'string', defaultValue: '09:00', format: 'hhmm' })).toEqual([])
  })

  it('rejects a default that violates its own rules', () => {
    const errors = validateDefinitionRules({ ...base, type: 'integer', defaultValue: 50, minValue: 1, maxValue: 10 })
    expect(errors[0].message).toContain('Default is invalid')
  })

  it('rejects rules that do not fit the type', () => {
    expect(validateDefinitionRules({ ...base, type: 'enum', defaultValue: 'a' })).toHaveLength(1)
    expect(validateDefinitionRules({ ...base, type: 'boolean', defaultValue: true, allowedValues: ['x', 'y'] })).toHaveLength(1)
    expect(validateDefinitionRules({ ...base, type: 'integer', defaultValue: 5, minValue: 9, maxValue: 1 })).toHaveLength(1)
    expect(validateDefinitionRules({ ...base, type: 'enum', defaultValue: 'a', allowedValues: ['a', 'a'] })).toHaveLength(1)
  })
})
