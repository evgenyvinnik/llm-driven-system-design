/**
 * Browser wiring: localStorage for the last known good snapshot and unsent
 * events, sendBeacon on pagehide / visibility hidden, and a persistent
 * anonymous id.
 * @module client/browser
 */
import { ExperimentClient, type ClientOptions } from './client.js'
import { uuid } from './ids.js'
import type { StorageAdapter } from './storage.js'

export function localStorageAdapter(): StorageAdapter | null {
  try {
    const ls = window.localStorage
    const probe = '__exp_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), remove: (k) => ls.removeItem(k) }
  } catch {
    return null
  }
}

const ANON_KEY = 'exp:anonymous-id'

/** The device's anonymous id, created on first visit and kept in localStorage. */
export function getAnonymousId(): string {
  try {
    const existing = window.localStorage.getItem(ANON_KEY)
    if (existing) return existing
    const id = `anon_${uuid()}`
    window.localStorage.setItem(ANON_KEY, id)
    return id
  } catch {
    return `anon_${uuid()}`
  }
}

/** On sign-out: a fresh anonymous id, so the next person on this device is a new unit. */
export function rotateAnonymousId(): string {
  try {
    window.localStorage.removeItem(ANON_KEY)
  } catch {
    // ignore
  }
  return getAnonymousId()
}

export function createBrowserClient(options: Omit<ClientOptions, 'beacon'>): ExperimentClient {
  const client = new ExperimentClient({
    storage: options.storage === undefined ? localStorageAdapter() : options.storage,
    ...options,
    beacon: (url, body) => {
      try {
        return navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' })) ?? false
      } catch {
        return false
      }
    },
  })
  window.addEventListener('pagehide', () => client.flushOnUnload())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') client.flushOnUnload()
  })
  return client
}
