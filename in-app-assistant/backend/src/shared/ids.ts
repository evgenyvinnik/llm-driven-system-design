/**
 * ID helpers. Host-app objects use short readable prefixed IDs (m_, doc_, ev_,
 * dr_) because the model sees them and has to copy them back exactly; turns
 * and conversations use UUIDs.
 * @module shared/ids
 */
import { randomBytes } from 'node:crypto'
import { HttpError } from './errors.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function uuidParam(value: unknown, what: string): string {
  if (!isUuid(value)) throw new HttpError(404, 'NOT_FOUND', `${what} not found`)
  return value.toLowerCase()
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** e.g. shortId('m') -> "m_k3f9q2" */
export function shortId(prefix: string, length = 6): string {
  const bytes = randomBytes(length)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return `${prefix}_${out}`
}

export function idParam(value: unknown, prefix: string, what: string): string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-z0-9]{1,24}$`).test(value)) {
    throw new HttpError(404, 'NOT_FOUND', `${what} not found`)
  }
  return value
}
