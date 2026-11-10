/**
 * Request helpers shared by the settings and admin routes.
 * @module api/http
 */
import type { Request } from 'express'
import { keys, redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { HttpError } from '../shared/errors.js'
import { parseIfMatch, type BaseRevision } from '../domain/patch.js'

/**
 * Writes must say which revision they were based on. A missing If-Match is a
 * 428, not a silent last-write-wins; `If-Match: *` is the explicit opt-in.
 */
export function requireIfMatch(req: Request): BaseRevision {
  const header = req.get('If-Match')
  if (header === undefined) {
    throw new HttpError(428, 'PRECONDITION_REQUIRED', 'Send If-Match with the revision you last read (or * to overwrite unconditionally)')
  }
  const parsed = parseIfMatch(header)
  if (parsed === null) throw new HttpError(400, 'BAD_IF_MATCH', 'If-Match must be a revision such as "12", or *')
  return parsed
}

function clean(value: string | undefined, max: number): string | null {
  if (!value) return null
  const trimmed = value.replace(/[^\w .:()/-]/g, '').trim().slice(0, max)
  return trimmed.length > 0 ? trimmed : null
}

/** Identifies the device: X-Client-Id (random per tab or app install) and a human label for the change log. */
export function clientIdentity(req: Request): { clientId: string | null; clientLabel: string | null } {
  return { clientId: clean(req.get('X-Client-Id'), 64), clientLabel: clean(req.get('X-Client-Label'), 60) }
}

/** Fixed one-minute window per user. */
export async function limitPatches(userId: string): Promise<void> {
  const key = keys.rate(`patch:${userId}:${Math.floor(Date.now() / 60_000)}`)
  const n = await redis.incr(key)
  if (n === 1) await redis.expire(key, 70)
  if (n > config.patchesPerMinute) throw new HttpError(429, 'RATE_LIMITED', 'Too many settings changes; slow down')
}

export const etag = (revision: number) => `"${revision}"`
