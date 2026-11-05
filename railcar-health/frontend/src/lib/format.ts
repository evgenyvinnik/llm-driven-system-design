export function ageText(fromIso: string | null | undefined, nowMs: number): string {
  if (!fromIso) return '—'
  const minutes = Math.max(0, Math.round((nowMs - new Date(fromIso).getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min ago`
  return `${Math.floor(hours / 24)} d ago`
}

export function lagText(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export function timeText(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function dateTimeText(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const signed = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : ''}${Math.round(n)}`)

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`)

export const humanize = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—')

const ROUTING: Record<string, string> = {
  dispatcher_and_yard: 'Dispatcher + yard',
  yard: 'Next yard',
  yard_post_arrival: 'Yard (after arrival)',
  owner_only: 'Owner notice',
}
export const routingText = (r: string) => ROUTING[r] ?? humanize(r)

const ACTIONS: Record<string, string> = {
  stop_and_inspect: 'Stop and inspect',
  setout_or_restricted_speed: 'Set out or restricted speed',
  inspect_next_terminal: 'Bearing inspection at next terminal',
  monitor_notify_owner: 'Monitor, notify owner',
  brake_inspection_next_terminal: 'Brake inspection at next terminal',
  brake_inspection_setout: 'Brake inspection: set out or cut out the brake',
}
export const actionText = (a: string) => ACTIONS[a] ?? humanize(a)

export const positionText = (kind: string, position: string) => (kind === 'hot_bearing' ? `bearing ${position}` : 'brakes (whole car)')

/** Bearings and brakes are different failure modes; say which. */
export const kindText = (kind: string) =>
  ({ hot_bearing: 'hot bearing', hot_wheel: 'hot wheels · stuck brake', cold_wheel: 'cold wheels · inoperative brake', audit: 'audit inspection' })[kind] ?? humanize(kind)

const CHAIN: Record<string, string[]> = {
  dispatcher: ['dispatcher desk', 'chief dispatcher', 'operations center'],
  yard: ['yard inspectors', 'yard foreman', 'operations center'],
}
export function ownerText(role: string | null, id: string | null, level: number): string {
  if (!role) return '—'
  if (role === 'owner') return `car owner ${id ?? ''}`.trim()
  const chain = CHAIN[role] ?? [role]
  return `${chain[Math.min(level, chain.length - 1)]}${level === 0 && id ? ` ${id}` : ''}`
}

/** "due in 4 min" / "overdue 3 min" from the server clock. */
export function dueText(iso: string | null, nowMs: number): { text: string; overdue: boolean } | null {
  if (!iso) return null
  const minutes = Math.round((new Date(iso).getTime() - nowMs) / 60_000)
  return minutes >= 0 ? { text: `ack due in ${minutes} min`, overdue: false } : { text: `ack overdue ${-minutes} min`, overdue: true }
}
