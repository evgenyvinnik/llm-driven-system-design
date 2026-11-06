/**
 * Load shedding by client class. Each API instance admits a quote request
 * only while its in-flight count is below the class's share of maxInflight:
 * a re-quoting integration is refused first, then other integration traffic,
 * and a person in the portal last. A shed request costs a counter increment
 * and a 503 with Retry-After, never a dependency call.
 * @module api/services/admission
 */
import type { ClientClass } from '../../shared/reference.js'
import type { Settings } from '../../shared/settings.js'

export function admits(inflight: number, cls: ClientClass, shedding: Settings['shedding']): boolean {
  if (!shedding.enabled) return true
  const limit = Math.max(1, Math.floor(shedding.maxInflight * shedding.thresholds[cls]))
  return inflight < limit
}

/** Retry-After for a shed request: integrations are told to back off longer than people. */
export function retryAfterSeconds(cls: ClientClass): number {
  return cls === 'portal' ? 1 : cls === 'api' ? 2 : 5
}

/** An API client asking for the same inputs again within the window is re-quoting. */
export const REQUOTE_WINDOW_SECONDS = 60
