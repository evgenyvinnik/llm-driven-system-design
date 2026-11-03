/**
 * Which org the UI may show data for right now. Switching orgs aborts every
 * request still in flight for the old org (one AbortController per org
 * visit), and a response that arrives anyway is dropped before it can reach
 * any state. Query keys are org-scoped too, so even a response that slipped
 * through could only land in the old org's cache entry, never on screen.
 */

let activeOrgId: string | null = null
let controller = new AbortController()
let dropped = 0

export class StaleOrgResponse extends Error {
  constructor(
    public orgId: string,
    public path: string,
  ) {
    super(`Dropped a late response for ${orgId}: ${path}`)
    this.name = 'StaleOrgResponse'
  }
}

export function getActiveOrgId(): string | null {
  return activeOrgId
}

/** Returns the org that was active before, or null if nothing changed. */
export function activateOrg(orgId: string | null): string | null {
  if (orgId === activeOrgId) return null
  const previous = activeOrgId
  controller.abort(new DOMException(`Switched from ${previous} to ${orgId}`, 'AbortError'))
  controller = new AbortController()
  activeOrgId = orgId
  return previous
}

/** Aborts when the user leaves the current org. */
export function scopeSignal(): AbortSignal {
  return controller.signal
}

/** Called after every org-scoped response: throws if the user has moved to another org meanwhile. */
export function assertStillActive(orgId: string, path: string): void {
  if (orgId === activeOrgId) return
  dropped += 1
  console.info(`[org-scope] ${new StaleOrgResponse(orgId, path).message}`)
  throw new StaleOrgResponse(orgId, path)
}

export function droppedResponseCount(): number {
  return dropped
}

/** AbortSignal.any with a fallback for older browsers. */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => Boolean(s))
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const merged = new AbortController()
  for (const s of list) {
    if (s.aborted) merged.abort(s.reason)
    else s.addEventListener('abort', () => merged.abort(s.reason), { once: true })
  }
  return merged.signal
}
