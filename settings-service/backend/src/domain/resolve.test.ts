import { describe, expect, it } from 'vitest'
import { CATALOG, DEFS, NOW, org, rows, user } from './fixtures.js'
import { keyStatus, resolveAll, resolveEntry } from './resolve.js'

const theme = DEFS.get('appearance.theme')!
const retention = DEFS.get('privacy.data_retention_days')!

describe('resolveEntry precedence', () => {
  it('falls back to the global default when nobody set anything', () => {
    expect(resolveEntry(theme, undefined, undefined)).toEqual({ value: 'system', source: 'default', locked: false, lockReason: null, rev: 0 })
  })

  it('uses the org default over the global default', () => {
    expect(resolveEntry(theme, org('appearance.theme', 'dark'), undefined)).toMatchObject({ value: 'dark', source: 'org', locked: false })
  })

  it("uses the user's value over the org default", () => {
    const e = resolveEntry(theme, org('appearance.theme', 'dark'), user('appearance.theme', 'light', 7))
    expect(e).toMatchObject({ value: 'light', source: 'user', locked: false, rev: 7, updatedBy: 'Laptop' })
  })

  it("an enforced org value beats the user's value, which is kept and reported", () => {
    const e = resolveEntry(theme, org('appearance.theme', 'dark', true), user('appearance.theme', 'light', 7))
    expect(e).toMatchObject({ value: 'dark', source: 'enforced', locked: true, lockReason: 'enforced', userValue: 'light', rev: 7 })
  })

  it('enforcement without a user value has no userValue', () => {
    const e = resolveEntry(theme, org('appearance.theme', 'dark', true), undefined)
    expect(e.userValue).toBeUndefined()
    expect(e.source).toBe('enforced')
  })

  it('a user tombstone (reset) inherits but keeps its revision', () => {
    const e = resolveEntry(theme, org('appearance.theme', 'dark'), user('appearance.theme', null, 9))
    expect(e).toMatchObject({ value: 'dark', source: 'org', rev: 9 })
  })

  it('an org tombstone (policy cleared) is ignored, even if it was enforced', () => {
    const e = resolveEntry(theme, org('appearance.theme', null, true), undefined)
    expect(e).toMatchObject({ value: 'system', source: 'default', locked: false })
  })

  it('org-scoped keys are always locked: org value, else default', () => {
    expect(resolveEntry(retention, org('privacy.data_retention_days', 90), undefined)).toMatchObject({
      value: 90,
      source: 'org',
      locked: true,
      lockReason: 'org_scope',
    })
    expect(resolveEntry(retention, undefined, undefined)).toMatchObject({ value: 365, source: 'default', locked: true, lockReason: 'org_scope' })
  })
})

describe('resolveAll', () => {
  it('omits retired keys and flags deprecated ones', () => {
    const all = resolveAll(CATALOG, new Map(), rows(user('appearance.compact_mode', true, 3)), NOW)
    expect(all['notifications.sms_enabled']).toBeUndefined()
    expect(all['appearance.compact_mode']).toMatchObject({ value: true, source: 'user', deprecated: true })
    expect(Object.keys(all)).toHaveLength(CATALOG.length - 1)
  })

  it('a definition added at runtime resolves to its default for an existing user with no backfill', () => {
    const before = resolveAll(CATALOG, new Map(), rows(user('appearance.theme', 'dark', 4)), NOW)
    const added = { ...CATALOG[0], key: 'notifications.weekly_report', type: 'boolean' as const, defaultValue: true, allowedValues: null }
    const after = resolveAll([...CATALOG, added], new Map(), rows(user('appearance.theme', 'dark', 4)), NOW)
    expect(before['notifications.weekly_report']).toBeUndefined()
    expect(after['notifications.weekly_report']).toMatchObject({ value: true, source: 'default', rev: 0 })
    expect(after['appearance.theme']).toEqual(before['appearance.theme'])
  })
})

describe('keyStatus', () => {
  it('is active, deprecated inside the grace window, retired from the sunset instant', () => {
    expect(keyStatus(theme, NOW)).toBe('active')
    expect(keyStatus(DEFS.get('appearance.compact_mode')!, NOW)).toBe('deprecated')
    const sms = DEFS.get('notifications.sms_enabled')!
    expect(keyStatus(sms, NOW)).toBe('retired')
    expect(keyStatus(sms, sms.sunsetAt!)).toBe('retired')
    expect(keyStatus(sms, new Date(sms.sunsetAt!.getTime() - 1))).toBe('deprecated')
  })
})
