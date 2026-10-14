/**
 * Quiet-hours arithmetic in the recipient's own time zone.
 *
 * Quiet hours are stored as minutes from local midnight (0-1439) plus an IANA
 * time zone. Everything here is evaluated with Intl in that zone, so "22:00 to
 * 07:00" means the recipient's evening regardless of where the server runs,
 * and the deferral target lands on 07:00 local even across a DST change.
 */

export interface QuietHoursWindow {
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
}

const MINUTES_PER_DAY = 1440;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when `timeZone` is an IANA zone name this runtime understands. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) {
    return false;
  }
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Minutes since local midnight at instant `at` in `timeZone` (falls back to UTC). */
export function localMinutes(at: Date, timeZone: string): number {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = formatterFor(zone).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/**
 * Whether `at` falls inside the window. Start == end is treated as "no quiet
 * hours" rather than "quiet all day", which is never what a user means.
 */
export function isWithinQuietHours(window: QuietHoursWindow, at: Date): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = window;
  if (start === null || end === null || start === end) {
    return false;
  }
  const now = localMinutes(at, window.timezone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * The next instant after `at` at which the recipient's local clock reads the
 * window's end time. One correction pass absorbs a DST jump inside the wait.
 */
export function nextQuietHoursEnd(window: QuietHoursWindow, at: Date): Date {
  const end = window.quietHoursEnd ?? 0;
  const zone = window.timezone;
  const startOfMinute = Math.floor(at.getTime() / 60000) * 60000;

  let wait = (end - localMinutes(at, zone) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (wait === 0) wait = MINUTES_PER_DAY;
  let candidate = new Date(startOfMinute + wait * 60000);

  const drift = (end - localMinutes(candidate, zone) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (drift !== 0) {
    const shift = drift > MINUTES_PER_DAY / 2 ? drift - MINUTES_PER_DAY : drift;
    candidate = new Date(candidate.getTime() + shift * 60000);
  }
  return candidate;
}

/**
 * When a delivery requested for `requestedAt` may actually go out: unchanged
 * for critical sends or outside quiet hours, otherwise the end of the window.
 */
export function deliveryTimeAfterQuietHours(
  window: QuietHoursWindow,
  requestedAt: Date,
  priority: string
): { deliverAt: Date; deferred: boolean } {
  if (priority === 'critical' || !isWithinQuietHours(window, requestedAt)) {
    return { deliverAt: requestedAt, deferred: false };
  }
  return { deliverAt: nextQuietHoursEnd(window, requestedAt), deferred: true };
}
