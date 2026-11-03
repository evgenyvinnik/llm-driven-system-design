/**
 * Time zone arithmetic. Models are unreliable at date math and time zone
 * conversion, so tools accept a local date and time plus a zone and convert
 * here, and the orchestrator puts today's date (in the user's zone) in every
 * turn so "next Tuesday" can be resolved.
 * @module shared/time
 */

/** "2026-11-02" for the current date in the given zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  return ymdIn(now, timeZone)
}

export function ymdIn(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function weekdayOf(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
}

/** The zone's UTC offset at a given instant, e.g. "-08:00". */
function offsetAt(date: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')!.value
  const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(name)
  return match ? `${match[1]}:${match[2] ?? '00'}` : '+00:00'
}

/** Converts a wall-clock time in a zone to an instant, handling DST at that date. */
export function zonedTime(ymd: string, hhmm: string, timeZone: string): Date {
  const guess = new Date(`${ymd}T${hhmm}:00Z`)
  const first = new Date(`${ymd}T${hhmm}:00${offsetAt(guess, timeZone)}`)
  return new Date(`${ymd}T${hhmm}:00${offsetAt(first, timeZone)}`)
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function formatLocal(date: Date, timeZone: string): string {
  return date.toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** "2026-10-26 09:12" in the given zone: unambiguous for the model, sortable. */
export function stampIn(date: Date, timeZone: string): string {
  const time = date.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
  return `${ymdIn(date, timeZone)} ${time}`
}
