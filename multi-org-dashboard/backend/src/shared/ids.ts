/**
 * Path parameter validation. A malformed ID is reported as "not found" rather
 * than reaching PostgreSQL as an invalid value, so a probe can't tell a bad ID
 * from a resource it isn't allowed to see.
 * @module shared/ids
 */
import { createHash, randomBytes } from 'node:crypto'
import { HttpError } from './errors.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ORG_ID = /^org_[a-z0-9]{3,32}$/
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function isOrgId(value: unknown): value is string {
  return typeof value === 'string' && ORG_ID.test(value)
}

export function uuidParam(value: unknown, what: string): string {
  if (!isUuid(value)) throw new HttpError(404, 'NOT_FOUND', `${what} not found`)
  return value.toLowerCase()
}

export function tokenParam(value: unknown, what: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new HttpError(404, 'NOT_FOUND', `${what} not found`)
  return value
}

export function newOrgId(): string {
  return `org_${randomBytes(8).toString('hex')}`
}

/** Bearer tokens (invitations, share links) are stored only as hashes. */
export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
