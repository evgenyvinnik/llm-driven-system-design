/**
 * Formatting helpers for settings: labels for values, sources and times.
 * @module lib/display
 */
import type { Definition, EffectiveEntry, SettingValue } from '@/types'
import type { PendingEdit } from './settings-store'

export const CATEGORY_ORDER = ['notifications', 'appearance', 'privacy', 'regional', 'profile', 'security']

export const CATEGORY_TITLES: Record<string, string> = {
  notifications: 'Notifications',
  appearance: 'Appearance',
  privacy: 'Privacy',
  regional: 'Language & region',
  profile: 'Profile',
  security: 'Security',
}

export function categoryTitle(category: string): string {
  return CATEGORY_TITLES[category] ?? category.charAt(0).toUpperCase() + category.slice(1)
}

export function groupByCategory(defs: Definition[]): Array<[string, Definition[]]> {
  const groups = new Map<string, Definition[]>()
  for (const d of defs) {
    if (d.status === 'retired') continue
    const list = groups.get(d.category) ?? []
    list.push(d)
    groups.set(d.category, list)
  }
  const rank = (c: string) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length)
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
}

const ENUM_LABELS: Record<string, string> = {
  off: 'Off',
  daily: 'Daily',
  weekly: 'Weekly',
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  comfortable: 'Comfortable',
  compact: 'Compact',
  everyone: 'Everyone',
  organization: 'My organization',
  nobody: 'Nobody',
  mdy: 'MM/DD/YYYY',
  dmy: 'DD/MM/YYYY',
  ymd: 'YYYY-MM-DD',
  sunday: 'Sunday',
  monday: 'Monday',
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'de-DE': 'Deutsch',
  'fr-FR': 'Français',
  'es-ES': 'Español',
  'ja-JP': '日本語',
}

export function optionLabel(value: string): string {
  return ENUM_LABELS[value] ?? value
}

export function formatValue(def: Pick<Definition, 'type'> | undefined, value: SettingValue | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'string') return value === '' ? '(empty)' : optionLabel(value)
  return def?.type === 'integer' ? String(value) : String(value)
}

/** What the control shows: the pending edit if there is one (optimistic), else the server's effective value. */
export function displayValue(entry: EffectiveEntry | undefined, pending: PendingEdit | undefined): SettingValue | undefined {
  if (pending && pending.value !== null && pending.status !== 'error') return pending.value
  return entry?.value
}

export function sourceLabel(entry: EffectiveEntry, orgName: string): string {
  switch (entry.source) {
    case 'enforced':
      return `Enforced by ${orgName}`
    case 'user':
      return 'Your choice'
    case 'org':
      return entry.lockReason === 'org_scope' ? `Set by ${orgName}` : `${orgName} default`
    case 'default':
      return 'Default'
  }
}

export function timeAgo(iso: string | number | undefined, now = Date.now()): string {
  if (iso === undefined) return ''
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function newClientId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${rand}`
}
