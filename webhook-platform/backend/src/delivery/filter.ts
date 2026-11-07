/**
 * Event-type filters on endpoints: `*` (everything), `order.*` (a family) or
 * an exact type such as `invoice.paid`.
 * @module delivery/filter
 */

export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
export const FILTER_PATTERN = /^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+)$/

export function matchesEventType(filters: string[], type: string): boolean {
  for (const f of filters) {
    if (f === '*') return true
    if (f.endsWith('.*')) {
      if (type.startsWith(f.slice(0, -1))) return true
    } else if (f === type) return true
  }
  return false
}
