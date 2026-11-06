/** Display helpers for event envelopes. */
import type { StoredEvent } from '@/types'

const FAMILY_STYLE: Array<[string, string, string]> = [
  ['wayside', 'Wayside', 'bg-slate-100 text-slate-700 ring-slate-300'],
  ['identity', 'Identity', 'bg-violet-50 text-violet-800 ring-violet-200'],
  ['trends', 'Trends', 'bg-amber-50 text-amber-800 ring-amber-200'],
  ['trips', 'Trips', 'bg-sky-50 text-sky-800 ring-sky-200'],
  ['detectors', 'Detectors', 'bg-teal-50 text-teal-800 ring-teal-200'],
  ['cases', 'Cases', 'bg-rose-50 text-rose-800 ring-rose-200'],
  ['cars', 'Cars', 'bg-emerald-50 text-emerald-800 ring-emerald-200'],
]

export const familyGroup = (family: string) => FAMILY_STYLE.find(([prefix]) => family.startsWith(prefix)) ?? FAMILY_STYLE[0]
export const familyStyle = (family: string) => familyGroup(family)[2]
export const FAMILY_GROUPS = FAMILY_STYLE.map(([prefix, label]) => ({ prefix, label }))

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—')

/** Local wall-clock time with seconds, plus the date when it is not today. */
export function clockText(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** How long after it happened we learned about it (processing time minus event time). */
export function lagSeconds(e: Pick<StoredEvent, 'occurredAt' | 'recordedAt'>): number {
  return Math.round((new Date(e.recordedAt).getTime() - new Date(e.occurredAt).getTime()) / 1000)
}

export function durationText(seconds: number): string {
  const s = Math.abs(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  const h = Math.floor(s / 3600)
  return `${h} h ${Math.round((s % 3600) / 60)} min`
}

/** A stable colour per correlation id, so one business flow reads as one colour down the list. */
export function correlationStyle(id: string): string {
  const palette = ['bg-sky-100 text-sky-900', 'bg-amber-100 text-amber-900', 'bg-emerald-100 text-emerald-900', 'bg-fuchsia-100 text-fuchsia-900', 'bg-lime-100 text-lime-900', 'bg-orange-100 text-orange-900', 'bg-indigo-100 text-indigo-900', 'bg-rose-100 text-rose-900']
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

export const streamLabel = (e: Pick<StoredEvent, 'streamId' | 'streamVersion'>) => {
  const [kind, ...rest] = e.streamId.split('-')
  const id = rest.join('-')
  return `${kind}-${kind === 'case' ? shortId(id) : id} #${e.streamVersion}`
}
