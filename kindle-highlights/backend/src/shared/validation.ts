/**
 * Request validation at the service boundary (no dependencies; returns typed values or a reason)
 * @module shared/validation
 */

export const COLORS = ['yellow', 'orange', 'blue', 'green', 'pink'] as const
export const VISIBILITIES = ['private', 'friends', 'public'] as const
export type Color = (typeof COLORS)[number]
export type Visibility = (typeof VISIBILITIES)[number]

export const MAX_TEXT_LENGTH = 5000
export const MAX_NOTE_LENGTH = 10000
export const MAX_SYNC_OPS = 100

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** A highlight as the client creates it. `id` is minted on the device and is the idempotency key. */
export interface NewHighlight {
  id?: string
  bookId: string
  locationStart: number
  locationEnd: number
  text: string
  note: string | null
  color: Color
  /** Omitted: the owner's default from user_privacy_settings applies. */
  visibility?: Visibility
}

/** The mutable fields of a highlight; the text and location range never change after creation. */
export interface HighlightChanges {
  note?: string | null
  color?: Color
  visibility?: Visibility
}

/** One entry of a device's offline outbox, pushed in a batch to POST /api/sync/push. */
export type SyncOp =
  | { opId: string; kind: 'create'; highlight: NewHighlight & { id: string }; clientUpdatedAt?: number }
  | { opId: string; kind: 'update'; id: string; changes: HighlightChanges; clientUpdatedAt?: number }
  | { opId: string; kind: 'delete'; id: string; clientUpdatedAt?: number }

/** True when the value is a canonical UUID string. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Validates the body of a highlight create (REST or sync). */
export function parseNewHighlight(body: unknown): Validation<NewHighlight> {
  if (!isRecord(body)) return fail('Body must be an object')
  const { id, bookId, locationStart, locationEnd, text, note = null, color = 'yellow', visibility } = body
  if (id !== undefined && !isUuid(id)) return fail('id must be a UUID')
  if (!isUuid(bookId)) return fail('bookId must be a UUID')
  if (!isNonNegativeInt(locationStart) || !isNonNegativeInt(locationEnd)) {
    return fail('locationStart and locationEnd must be non-negative integers')
  }
  if (locationEnd < locationStart) return fail('locationEnd must not be before locationStart')
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT_LENGTH) {
    return fail(`text must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`)
  }
  if (note !== null && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
    return fail(`note must be a string of at most ${MAX_NOTE_LENGTH} characters`)
  }
  if (!COLORS.includes(color as Color)) return fail(`color must be one of ${COLORS.join(', ')}`)
  if (visibility !== undefined && !VISIBILITIES.includes(visibility as Visibility)) {
    return fail(`visibility must be one of ${VISIBILITIES.join(', ')}`)
  }
  return {
    ok: true,
    value: {
      // PostgreSQL returns UUIDs lowercase; normalize so a replay compares equal to the stored row
      id: typeof id === 'string' ? id.toLowerCase() : undefined,
      bookId: bookId.toLowerCase(),
      locationStart,
      locationEnd,
      text,
      note: note as string | null,
      color: color as Color,
      visibility: visibility as Visibility | undefined,
    },
  }
}

/** Validates a set of field changes; at least one known field must be present. */
export function parseHighlightChanges(body: unknown): Validation<HighlightChanges> {
  if (!isRecord(body)) return fail('Body must be an object')
  const changes: HighlightChanges = {}
  if ('note' in body) {
    const note = body.note
    if (note !== null && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
      return fail(`note must be null or a string of at most ${MAX_NOTE_LENGTH} characters`)
    }
    changes.note = note as string | null
  }
  if ('color' in body) {
    if (!COLORS.includes(body.color as Color)) return fail(`color must be one of ${COLORS.join(', ')}`)
    changes.color = body.color as Color
  }
  if ('visibility' in body) {
    if (!VISIBILITIES.includes(body.visibility as Visibility)) {
      return fail(`visibility must be one of ${VISIBILITIES.join(', ')}`)
    }
    changes.visibility = body.visibility as Visibility
  }
  if (Object.keys(changes).length === 0) return fail('Provide at least one of note, color, visibility')
  return { ok: true, value: changes }
}

/** A device's wall-clock time for an edit, in epoch milliseconds; anything else uses the fallback. */
export function parseClientTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** Parses a positive integer query parameter, clamped to [1, max]. */
export function parseLimit(value: unknown, defaultValue: number, max: number): number {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : NaN
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue
  return Math.min(parsed, max)
}

/** Parses a non-negative integer query parameter (cursors, offsets). */
export function parseNonNegative(value: unknown, defaultValue: number): number {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue
}

/** Validates one pushed sync operation. Invalid ops are rejected individually, never retried. */
export function parseSyncOp(raw: unknown): Validation<SyncOp> {
  if (!isRecord(raw)) return fail('Operation must be an object')
  const { opId, kind, clientUpdatedAt } = raw
  if (typeof opId !== 'string' || opId === '' || opId.length > 100) return fail('opId must be a short string')
  const stamp = clientUpdatedAt === undefined ? undefined : parseClientTimestamp(clientUpdatedAt, NaN)
  if (stamp !== undefined && Number.isNaN(stamp)) return fail('clientUpdatedAt must be epoch milliseconds')

  if (kind === 'create') {
    const parsed = parseNewHighlight(raw.highlight)
    if (!parsed.ok) return parsed
    if (!parsed.value.id) return fail('Offline creates must carry a client-generated highlight id')
    return { ok: true, value: { opId, kind, highlight: { ...parsed.value, id: parsed.value.id }, clientUpdatedAt: stamp } }
  }
  if (kind === 'update') {
    if (!isUuid(raw.id)) return fail('id must be a UUID')
    const parsed = parseHighlightChanges(raw.changes)
    if (!parsed.ok) return parsed
    return { ok: true, value: { opId, kind, id: raw.id.toLowerCase(), changes: parsed.value, clientUpdatedAt: stamp } }
  }
  if (kind === 'delete') {
    if (!isUuid(raw.id)) return fail('id must be a UUID')
    return { ok: true, value: { opId, kind, id: raw.id.toLowerCase(), clientUpdatedAt: stamp } }
  }
  return fail('kind must be create, update or delete')
}
