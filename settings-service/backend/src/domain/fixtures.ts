/**
 * Test fixtures: a small catalog and row builders shared by the domain tests.
 * @module domain/fixtures
 */
import type { Definition, OrgValue, SettingValue, UserValue } from './types.js'

export const NOW = new Date('2026-11-01T12:00:00Z')
const DAY = 86_400_000

export function def(key: string, over: Partial<Definition> = {}): Definition {
  return {
    key,
    type: 'boolean',
    scope: 'user',
    defaultValue: false,
    allowedValues: null,
    minValue: null,
    maxValue: null,
    maxLength: null,
    format: null,
    category: key.split('.')[0],
    label: key,
    description: '',
    displayOrder: 10,
    deprecatedAt: null,
    sunsetAt: null,
    replacedBy: null,
    catalogRev: 1,
    ...over,
  }
}

export const CATALOG: Definition[] = [
  def('appearance.theme', { type: 'enum', defaultValue: 'system', allowedValues: ['system', 'light', 'dark'] }),
  def('appearance.font_scale', { type: 'integer', defaultValue: 100, minValue: 80, maxValue: 150 }),
  def('regional.language', { type: 'enum', defaultValue: 'en-US', allowedValues: ['en-US', 'en-GB', 'de-DE'] }),
  def('regional.time_zone', { type: 'string', defaultValue: 'UTC', format: 'timezone' }),
  def('notifications.quiet_hours_start', { type: 'string', defaultValue: '22:00', format: 'hhmm' }),
  def('profile.status_message', { type: 'string', defaultValue: '', maxLength: 10 }),
  def('privacy.read_receipts', { defaultValue: true }),
  def('privacy.data_retention_days', { type: 'integer', scope: 'org', defaultValue: 365, minValue: 30, maxValue: 3650 }),
  def('appearance.compact_mode', {
    deprecatedAt: new Date(NOW.getTime() - 10 * DAY),
    sunsetAt: new Date(NOW.getTime() + 20 * DAY),
    replacedBy: 'appearance.theme',
  }),
  def('notifications.sms_enabled', {
    deprecatedAt: new Date(NOW.getTime() - 60 * DAY),
    sunsetAt: new Date(NOW.getTime() - 30 * DAY),
    replacedBy: 'privacy.read_receipts',
  }),
]

export const DEFS = new Map(CATALOG.map((d) => [d.key, d]))

export function org(key: string, value: SettingValue | null, enforced = false, rev = 1): OrgValue {
  return { key, value, enforced, rev, updatedAt: NOW }
}

export function user(key: string, value: SettingValue | null, rev: number, updatedBy: string | null = 'Laptop'): UserValue {
  return { key, value, rev, updatedAt: NOW, updatedBy }
}

export const rows = <T extends { key: string }>(...items: T[]) => new Map(items.map((i) => [i.key, i]))
