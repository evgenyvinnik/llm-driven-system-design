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
  inspect_next_terminal: 'Inspect at next terminal',
  monitor_notify_owner: 'Monitor, notify owner',
}
export const actionText = (a: string) => ACTIONS[a] ?? humanize(a)

export const positionText = (kind: string, position: string) => (kind === 'hot_wheel' ? 'wheels (whole car)' : `bearing ${position}`)
