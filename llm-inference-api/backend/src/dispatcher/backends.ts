/**
 * The dispatcher's view of the model backends. Health is polled every
 * HEALTH_POLL_MS, so this view can be up to that stale; that is fine because
 * the backend is the authority on its own admission. A refusal (draining,
 * restarting, overloaded) corrects the view immediately and the work is
 * re-routed; nothing has been generated yet, so nothing is lost.
 * Load: this dispatcher's own in-flight count is exact for work it sent. The
 * backend's reported `inUse` also covers work it cannot see (a previous
 * leader's streams, slots a static batch holds), but it is up to one poll old,
 * so it only counts when it was taken after the last local release. Otherwise
 * a report from before a burst finished would make an idle backend look busy
 * and push its prefixes onto other backends (lost cache hits).
 * @module dispatcher/backends
 */
import { keys, redis } from '../shared/cache.js'
import { config, type BackendRef } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { slotsInUse } from '../shared/metrics.js'
import type { BackendLoad } from './router.js'

export interface BackendHealth {
  status: 'ok' | 'draining' | 'restarting'
  model: string
  version: string
  targetVersion: string | null
  batching: string
  slots: number
  inUse: number
  active: number
  prefilling: number
  decoding: number
  cache: { entries: number; capacity: number; hitRate: number | null; hits: number; misses: number }
  chaos: Record<string, number>
  settings: Record<string, number>
  counters: Record<string, number>
}

export interface BackendState {
  id: string
  url: string
  health: BackendHealth | null
  reachable: boolean
  lastSeen: number | null
  cooldownUntil: number
  cooldownReason: string | null
  /** Requests this dispatcher has sent there and not yet seen finish. */
  inflight: number
  /** When the last health report was requested, and when we last saw work finish there. */
  healthAt: number
  lastReleaseAt: number
}

export class BackendRegistry {
  readonly states = new Map<string, BackendState>()

  constructor(backends: BackendRef[] = config.backends) {
    for (const b of backends) {
      this.states.set(b.id, { id: b.id, url: b.url, health: null, reachable: false, lastSeen: null, cooldownUntil: 0, cooldownReason: null, inflight: 0, healthAt: 0, lastReleaseAt: 0 })
    }
  }

  get ids(): string[] {
    return [...this.states.keys()]
  }

  url(id: string): string {
    return (this.states.get(id) as BackendState).url
  }

  async pollOnce(): Promise<void> {
    await Promise.all(
      [...this.states.values()].map(async (s) => {
        const askedAt = Date.now()
        try {
          const r = await fetch(`${s.url}/health`, { signal: AbortSignal.timeout(400) })
          if (!r.ok) throw new Error(`status ${r.status}`)
          s.health = (await r.json()) as BackendHealth
          s.healthAt = askedAt
          s.reachable = true
          s.lastSeen = Date.now()
          slotsInUse.set({ backend: s.id }, s.health.inUse)
        } catch (err) {
          if (s.reachable) logger.warn({ backend: s.id, err: err instanceof Error ? err.message : err }, 'backend unreachable')
          s.reachable = false
        }
      }),
    )
  }

  isRoutable(s: BackendState, now: number): boolean {
    return s.reachable && s.health !== null && s.health.status === 'ok' && now >= s.cooldownUntil
  }

  loads(now = Date.now()): Map<string, BackendLoad> {
    const out = new Map<string, BackendLoad>()
    for (const s of this.states.values()) {
      out.set(s.id, {
        id: s.id,
        routable: this.isRoutable(s, now),
        inUse: s.healthAt > s.lastReleaseAt ? Math.max(s.inflight, s.health?.inUse ?? 0) : s.inflight,
        slots: s.health?.slots ?? 0,
      })
    }
    return out
  }

  capacity(now = Date.now()): { free: number; total: number } {
    let free = 0
    let total = 0
    for (const l of this.loads(now).values()) {
      if (!l.routable) continue
      total += l.slots
      free += Math.max(0, l.slots - l.inUse)
    }
    return { free, total }
  }

  addInflight(id: string, n: number): void {
    const s = this.states.get(id)
    if (s) s.inflight += n
  }

  releaseInflight(id: string, n = 1): void {
    const s = this.states.get(id)
    if (!s) return
    s.inflight = Math.max(0, s.inflight - n)
    s.lastReleaseAt = Date.now()
  }

  /** A backend refused a group: fix the local view now instead of waiting for the next poll. */
  markRefused(id: string, reason: string, status: number): void {
    const s = this.states.get(id)
    if (!s) return
    if (s.health && (reason === 'draining' || reason === 'restarting')) s.health.status = reason
    if (status === 529 || reason === 'refused' || reason === 'unreachable') {
      s.cooldownUntil = Date.now() + config.dispatcher.cooldownMs
      s.cooldownReason = reason
    }
    if (reason === 'unreachable') s.reachable = false
  }

  /** The stream to a backend broke: treat it as restarting until health says otherwise. */
  markStreamLost(id: string): void {
    const s = this.states.get(id)
    if (!s) return
    s.cooldownUntil = Date.now() + config.dispatcher.cooldownMs
    s.cooldownReason = 'stream_lost'
  }

  async publish(): Promise<void> {
    const now = Date.now()
    const fields: Record<string, string> = {}
    for (const s of this.states.values()) {
      fields[s.id] = JSON.stringify({
        id: s.id,
        url: s.url,
        reachable: s.reachable,
        routable: this.isRoutable(s, now),
        lastSeen: s.lastSeen,
        cooldownUntil: s.cooldownUntil > now ? s.cooldownUntil : null,
        cooldownReason: s.cooldownUntil > now ? s.cooldownReason : null,
        dispatcherInflight: s.inflight,
        ...(s.health ?? { status: 'unknown' }),
      })
    }
    await redis.multi().hset(keys.backends, fields).expire(keys.backends, 30).exec()
  }
}
