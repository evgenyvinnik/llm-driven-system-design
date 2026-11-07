/**
 * The storefront's one SDK client.
 *
 * - Evaluation is local; the first render never waits on the network for more
 *   than the provider's short budget (and not at all when a snapshot is cached).
 * - The last known good snapshot lives in localStorage; "simulate offline" in
 *   the inspector makes every SDK request fail so you can reload and watch the
 *   client start from that cache (or from the coded defaults after clearing it).
 * - Identity: the anonymous id lives in localStorage; after sign-in the shop's
 *   backend returns the stable id (identity alias) the SDK buckets by.
 */
import { createBrowserClient, getAnonymousId, rotateAnonymousId, type EvalContext } from 'experimentation-sdk'

const CLIENT_KEY = import.meta.env.VITE_CLIENT_KEY ?? 'cli_prod_4f9a2c7e1b3d5a60'
const OFFLINE_KEY = 'shop:simulate-offline'
const IDENTITY_KEY = 'shop:identity'

/** Safe coded defaults: what every visitor gets when no snapshot has ever been fetched. */
export const DEFAULTS = { checkout_cta: 'control', rewards_teaser: 'control', shipping_banner: 'control', new_search: 'off', promo_ribbon: 'off' }

export function isOffline(): boolean {
  try {
    return sessionStorage.getItem(OFFLINE_KEY) === '1'
  } catch {
    return false
  }
}

export function setOffline(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(OFFLINE_KEY, '1')
    else sessionStorage.removeItem(OFFLINE_KEY)
  } catch {
    // ignore
  }
}

/** Wraps fetch so the inspector's offline switch blocks only SDK traffic. */
const sdkFetch: typeof fetch = (input, init) => {
  if (isOffline()) return Promise.reject(new TypeError('offline (simulated)'))
  return fetch(input, init)
}

export interface StoredIdentity {
  userId: string
  stableId: string
  orgId?: string | null
  country?: string | null
  plan?: string | null
}

export function loadIdentity(): StoredIdentity | null {
  try {
    return JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? 'null') as StoredIdentity | null
  } catch {
    return null
  }
}

export function contextFor(anonymousId: string, identity: StoredIdentity | null): EvalContext {
  return {
    anonymousId,
    stableId: identity?.stableId ?? anonymousId,
    userId: identity?.userId,
    orgId: identity?.orgId ?? undefined,
    attributes: { platform: 'web', country: identity?.country ?? 'US', plan: identity?.plan ?? 'guest' },
  }
}

const anonymousId = getAnonymousId()

export const client = createBrowserClient({
  apiUrl: '/sdk/v1',
  clientKey: CLIENT_KEY,
  defaults: DEFAULTS,
  fetch: sdkFetch,
  initTimeoutMs: 800,
  pollIntervalMs: 15_000,
  label: `storefront ${anonymousId.slice(5, 13)}`,
  context: contextFor(anonymousId, loadIdentity()),
})

export function signedIn(identity: StoredIdentity): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
  } catch {
    // ignore
  }
  client.identify({ userId: identity.userId, stableId: identity.stableId, orgId: identity.orgId ?? undefined, attributes: { country: identity.country ?? undefined, plan: identity.plan ?? undefined } })
}

/** Sign-out starts a fresh anonymous unit, so the next person on this device isn't bucketed as the last one. */
export function signedOut(): void {
  try {
    localStorage.removeItem(IDENTITY_KEY)
  } catch {
    // ignore
  }
  client.setContext(contextFor(rotateAnonymousId(), null))
}

/** Removes the cached snapshot and dedup keys (for the defaults demo). */
export function clearSdkCache(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(`exp:${CLIENT_KEY}:`)) localStorage.removeItem(key)
  } catch {
    // ignore
  }
}
