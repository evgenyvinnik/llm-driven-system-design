/** Formatting helpers. */

export function money(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100)
}

export function moneyExact(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100)
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value >= 10_000) return `${(value / 1000).toFixed(0)} s`
  if (value >= 1_000) return `${(value / 1000).toFixed(1)} s`
  return `${Math.round(value)} ms`
}

export function age(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`
  return `${Math.round(seconds / 86_400)} d`
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  return s < 0 ? `in ${age(-s)}` : `${age(s)} ago`
}

/** "expires in 14 min" / "expired 3 min ago". */
export function validity(iso: string): { label: string; expired: boolean } {
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  if (s <= 0) return { label: `expired ${age(-s)} ago`, expired: true }
  return { label: `valid for ${age(s)}`, expired: false }
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export const shortId = (id: string) => id.slice(0, 8)

export const COMPONENT_LABEL: Record<string, string> = {
  linehaul: 'Linehaul',
  fuel_surcharge: 'Fuel surcharge',
  capacity_premium: 'Capacity premium',
  equipment: 'Equipment',
}

export const DEPENDENCY_LABEL: Record<string, string> = {
  pricing: 'Tariff & contract pricing',
  fuel: 'Fuel surcharge',
  capacity: 'Network capacity',
  availability: 'Car availability',
}

export const CLASS_LABEL: Record<string, string> = { portal: 'Portal', api: 'API', api_requote: 'API re-quote' }
