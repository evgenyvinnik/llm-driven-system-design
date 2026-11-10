import { describe, expect, it } from 'vitest'
import { DEFS, NOW, org, rows, user } from './fixtures.js'
import { parseIfMatch, planOrgChange, planUserPatch, type UserPatchInput } from './patch.js'
import type { OrgValue, UserValue } from './types.js'

function plan(patch: Record<string, unknown>, opts: Partial<UserPatchInput> = {}) {
  return planUserPatch({
    defs: DEFS,
    orgRows: new Map<string, OrgValue>(),
    userRows: new Map<string, UserValue>(),
    baseRevision: 12,
    patch,
    now: NOW,
    ...opts,
  })
}

describe('planUserPatch: concurrency', () => {
  // The user has revision 13: the phone changed the theme at 13. Language last changed at 5.
  const userRows = rows(user('appearance.theme', 'dark', 13, 'Phone'), user('regional.language', 'en-GB', 5))

  it('a different key based on an older revision still applies (phone and browser both survive)', () => {
    const p = plan({ 'regional.language': 'de-DE' }, { userRows, baseRevision: 12 })
    expect(p).toMatchObject({ kind: 'ok', changes: [{ key: 'regional.language', value: 'de-DE', previous: 'en-GB' }] })
  })

  it('the same key changed after the base revision is a conflict, never last-write-wins', () => {
    const p = plan({ 'appearance.theme': 'light' }, { userRows, baseRevision: 12 })
    expect(p).toEqual({
      kind: 'conflict',
      warnings: [],
      conflicts: [{ key: 'appearance.theme', baseRevision: 12, changedAtRevision: 13, yourValue: 'light', currentValue: 'dark', changedBy: 'Phone' }],
    })
  })

  it('one conflicting key fails the whole patch (atomic)', () => {
    const p = plan({ 'appearance.theme': 'light', 'regional.language': 'de-DE' }, { userRows, baseRevision: 12 })
    expect(p.kind).toBe('conflict')
  })

  it('writing the value that is already stored is a no-op even with a stale base (safe retry after a lost response)', () => {
    const p = plan({ 'appearance.theme': 'dark' }, { userRows, baseRevision: 12 })
    expect(p).toEqual({ kind: 'ok', changes: [], unchanged: ['appearance.theme'], warnings: [] })
  })

  it('a base equal to the key revision is not stale', () => {
    expect(plan({ 'appearance.theme': 'light' }, { userRows, baseRevision: 13 }).kind).toBe('ok')
  })

  it("If-Match: * writes unconditionally", () => {
    expect(plan({ 'appearance.theme': 'light' }, { userRows, baseRevision: '*' }).kind).toBe('ok')
  })

  it('null resets to inherited; resetting a key with no row is a no-op', () => {
    expect(plan({ 'regional.language': null }, { userRows, baseRevision: 13 })).toMatchObject({
      kind: 'ok',
      changes: [{ key: 'regional.language', value: null, previous: 'en-GB' }],
    })
    expect(plan({ 'appearance.font_scale': null }, { userRows })).toMatchObject({ kind: 'ok', changes: [], unchanged: ['appearance.font_scale'] })
  })

  it('a reset (tombstone) keeps its revision, so a stale writer still conflicts after delete', () => {
    const tomb = rows(user('appearance.theme', null, 14, 'Phone'))
    expect(plan({ 'appearance.theme': 'light' }, { userRows: tomb, baseRevision: 12 }).kind).toBe('conflict')
  })
})

describe('planUserPatch: validation', () => {
  it('rejects unknown keys with a per-field error and applies nothing', () => {
    const p = plan({ 'appearance.theme': 'dark', 'appearance.colour': 'red' })
    expect(p).toEqual({ kind: 'invalid', warnings: [], errors: [{ key: 'appearance.colour', code: 'UNKNOWN_KEY', message: 'No such setting' }] })
  })

  it('reports every bad field, not only the first', () => {
    const p = plan({ 'appearance.theme': 'purple', 'appearance.font_scale': 400, 'nope.key': 1 })
    expect(p.kind).toBe('invalid')
    if (p.kind === 'invalid') expect(p.errors.map((e) => e.code).sort()).toEqual(['NOT_ALLOWED', 'OUT_OF_RANGE', 'UNKNOWN_KEY'])
  })

  it('accepts and ignores a deprecated key in its grace window, with a warning', () => {
    const p = plan({ 'appearance.compact_mode': true, 'appearance.theme': 'dark' })
    expect(p.kind).toBe('ok')
    if (p.kind !== 'ok') return
    expect(p.changes.map((c) => c.key)).toEqual(['appearance.theme'])
    expect(p.warnings).toEqual([
      expect.objectContaining({ key: 'appearance.compact_mode', code: 'DEPRECATED_IGNORED', replacedBy: 'appearance.theme' }),
    ])
  })

  it('rejects a retired key (past sunset) with RETIRED and the replacement', () => {
    const p = plan({ 'notifications.sms_enabled': true })
    expect(p).toMatchObject({ kind: 'invalid', errors: [{ key: 'notifications.sms_enabled', code: 'RETIRED', replacedBy: 'privacy.read_receipts' }] })
  })

  it('rejects a write to an enforced key with LOCKED', () => {
    const p = plan({ 'privacy.read_receipts': false }, { orgRows: rows(org('privacy.read_receipts', true, true)) })
    expect(p).toMatchObject({ kind: 'invalid', errors: [{ key: 'privacy.read_receipts', code: 'LOCKED' }] })
  })

  it('allows a write to a key the org only defaults', () => {
    expect(plan({ 'privacy.read_receipts': false }, { orgRows: rows(org('privacy.read_receipts', true, false)) }).kind).toBe('ok')
  })

  it('rejects user writes to org-scoped keys', () => {
    expect(plan({ 'privacy.data_retention_days': 60 })).toMatchObject({ kind: 'invalid', errors: [{ code: 'NOT_USER_WRITABLE' }] })
  })

  it('validation errors win over conflicts (nothing about state is reported for a malformed request)', () => {
    const userRows = rows(user('appearance.theme', 'dark', 13))
    expect(plan({ 'appearance.theme': 'light', 'x.y': 1 }, { userRows }).kind).toBe('invalid')
  })
})

describe('planOrgChange', () => {
  const theme = DEFS.get('appearance.theme')
  it('sets, enforces, detects no-ops and conflicts', () => {
    expect(planOrgChange(theme, 'appearance.theme', undefined, 3, { value: 'dark', enforced: true }, NOW)).toMatchObject({ kind: 'change', enforced: true })
    const cur = org('appearance.theme', 'dark', true, 4)
    expect(planOrgChange(theme, 'appearance.theme', cur, 3, { value: 'dark', enforced: true }, NOW)).toEqual({ kind: 'unchanged' })
    expect(planOrgChange(theme, 'appearance.theme', cur, 3, { value: 'dark', enforced: false }, NOW)).toEqual({ kind: 'conflict', changedAtRevision: 4 })
    expect(planOrgChange(theme, 'appearance.theme', cur, 4, null, NOW)).toMatchObject({ kind: 'change', value: null })
  })

  it('validates the value and refuses policy on deprecated keys, but allows clearing it', () => {
    expect(planOrgChange(theme, 'appearance.theme', undefined, 0, { value: 'purple', enforced: false }, NOW)).toMatchObject({ kind: 'invalid' })
    const compact = DEFS.get('appearance.compact_mode')
    expect(planOrgChange(compact, 'appearance.compact_mode', undefined, 0, { value: true, enforced: true }, NOW)).toMatchObject({
      kind: 'invalid',
      error: { code: 'DEPRECATED' },
    })
    expect(planOrgChange(compact, 'appearance.compact_mode', org('appearance.compact_mode', true, true, 2), 2, null, NOW).kind).toBe('change')
  })

  it('never stores enforced=true for an org-scoped key', () => {
    const p = planOrgChange(DEFS.get('privacy.data_retention_days'), 'privacy.data_retention_days', undefined, 0, { value: 90, enforced: true }, NOW)
    expect(p).toMatchObject({ kind: 'change', value: 90, enforced: false })
  })
})

describe('parseIfMatch', () => {
  it('parses quoted, bare and weak revisions and *', () => {
    expect(parseIfMatch('"12"')).toBe(12)
    expect(parseIfMatch('12')).toBe(12)
    expect(parseIfMatch('W/"7"')).toBe(7)
    expect(parseIfMatch('*')).toBe('*')
    expect(parseIfMatch('"abc"')).toBeNull()
    expect(parseIfMatch(undefined)).toBeNull()
  })
})
