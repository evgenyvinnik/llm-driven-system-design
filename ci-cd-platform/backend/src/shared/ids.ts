/**
 * Prefixed random ids: readable in logs and URLs, unguessable, not sequential.
 * @module shared/ids
 */
import { randomBytes } from 'node:crypto'

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`
}
