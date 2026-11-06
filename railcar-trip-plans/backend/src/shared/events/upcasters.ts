/**
 * Upcasters: pure functions that turn an older payload version into the next one. Consumers run every
 * event through `upcast` before their handler sees it, so the log is never rewritten and handler code only
 * knows the latest version.
 *
 * Compatibility rules we follow:
 *   - Within a version, only optional fields with defaults may be added (zod `.default`).
 *   - Anything else (a new required field, a renamed or retyped field) is a new version plus an upcaster.
 *   - Consumers are deployed with the new upcaster before any producer emits the new version.
 *   - An upcaster never invents data: a field the old producer could not know becomes null / UNKNOWN.
 * @module shared/events/upcasters
 */
import { SCHEMAS, UnsupportedVersionError, type EventType } from './schemas.js'

type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>

export const UPCASTERS: Partial<Record<EventType, Record<number, Upcaster>>> = {
  CarSighted: {
    // v1 readers (older firmware) report no read confidence and no orientation.
    1: (p) => ({ ...p, readerConfidence: null, orientation: 'UNKNOWN' }),
  },
}

export interface Upcasted {
  version: number
  payload: Record<string, unknown>
  upcastFrom: number | null
}

/** Applies upcasters from `version` to the latest version of `type`. */
export function upcastPayload(type: EventType, version: number, payload: Record<string, unknown>): Upcasted {
  const latest = SCHEMAS[type].latest
  if (version > latest) throw new UnsupportedVersionError(type, version)
  let current = payload
  let v = version
  while (v < latest) {
    const step = UPCASTERS[type]?.[v]
    if (!step) throw new UnsupportedVersionError(type, v)
    current = step(current)
    v += 1
  }
  return { version: v, payload: current, upcastFrom: version === latest ? null : version }
}
