/**
 * The fencing rejection every runner write can get back.
 * @module scheduling/errors
 */
import { HttpError } from '../shared/errors.js'
import { staleWrites } from '../shared/metrics.js'

export function leaseLost(operation: string): HttpError {
  staleWrites.inc({ operation })
  return new HttpError(409, 'LEASE_LOST', 'This runner no longer holds the lease on this job; the write was rejected')
}
