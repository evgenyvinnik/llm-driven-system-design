/**
 * Path parameter validation. A malformed ID is reported as "not found" rather
 * than reaching PostgreSQL as an invalid UUID.
 * @module shared/ids
 */
import { HttpError } from './errors.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function uuidParam(value: unknown, what: string): string {
  if (!isUuid(value)) throw new HttpError(404, 'NOT_FOUND', `${what} not found`)
  return value.toLowerCase()
}
