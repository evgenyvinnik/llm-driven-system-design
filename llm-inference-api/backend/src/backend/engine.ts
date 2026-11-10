/**
 * Mock model engine: a fixed number of batch slots, iteration-level
 * (continuous) batching or static batching, a simulated prefix cache, model
 * versions with drain/upgrade, and chaos switches armed as counts.
 *
 * Timing model (deliberately simple, but each knob maps to a real effect):
 * - Each decode iteration emits one token for every decoding sequence; its
 *   period is 1000 / tokensPerSecond ms.
 * - A newly admitted sequence prefills for ttftMs + uncachedInputTokens ×
 *   prefillMsPerToken before its first token. A prefix-cache hit skips the
 *   cached part, which is what makes routing affinity worth having.
 * - Every admitted group stalls the next iteration by admitOverheadMs for all
 *   running sequences (scheduling, KV allocation, prefill launch). Admitting
 *   requests in groups pays that once per group, which is why the dispatcher
 *   batches at all even though the engine batches continuously.
 * - Continuous: a finished sequence frees its slot at once and a waiting one
 *   joins at the next iteration. Static: a group holds every slot until its
 *   longest member finishes.
 *
 * The engine has no timers in its logic: `admit(now)` and `step(now)` are
 * driven by the server loop, so tests run it with a fake clock.
 * @module backend/engine
 */
import { naturalLength, tokenStream } from './text.js'

export const CHAOS_KINDS = ['crash_mid_stream', 'refuse', 'slow', 'overload'] as const
export type ChaosKind = (typeof CHAOS_KINDS)[number]

export interface EngineSettings {
  model: string
  version: string
  slots: number
  ttftMs: number
  prefillMsPerToken: number
  tokensPerSecond: number
  admitOverheadMs: number
  cacheEntries: number
  batching: 'continuous' | 'static'
  restartMs: number
  crashAfterTokens: number
  slowExtraMs: number
}

export interface EngineItem {
  id: string
  prefixKey: string
  prefixTokens: number
  inputTokens: number
  maxTokens: number
  seed: string
  /** Mock-only: force the natural output length (load generator, tests). */
  outputTokens?: number
}

export type EngineEvent =
  | { t: 'first'; id: string; text: string; cachedTokens: number; inputTokens: number; version: string }
  | { t: 'tok'; id: string; text: string }
  | { t: 'done'; id: string; outputTokens: number; stopReason: 'end_turn' | 'max_tokens' }
  | { t: 'cancelled'; id: string; outputTokens: number }

export interface GroupSink {
  write: (events: EngineEvent[]) => void
  end: () => void
  /** Abrupt termination: the connection drops without a terminal event (a crash). */
  destroy: () => void
}

export class Refusal extends Error {
  constructor(
    public status: 503 | 529,
    public reason: 'draining' | 'restarting' | 'refused' | 'overloaded',
  ) {
    super(reason)
  }
}

interface Sequence {
  item: EngineItem
  groupId: string
  target: number
  readyAt: number
  decoding: boolean
  emitted: number
  cachedTokens: number
  crashAt: number | null
  next: () => string
}

interface Group {
  ids: Set<string>
  sink: GroupSink
}

export type EngineState = 'ok' | 'draining' | 'restarting'

export class Engine {
  state: EngineState = 'ok'
  targetVersion: string | null = null
  chaos: Record<ChaosKind, number> = { crash_mid_stream: 0, refuse: 0, slow: 0, overload: 0 }
  private seqs = new Map<string, Sequence>()
  private groups = new Map<string, Group>()
  /** LRU: Map iteration order is insertion order, so the first key is the least recently used. */
  private cache = new Map<string, number>()
  private window: boolean[] = []
  private stall = 0
  private restartTimer: NodeJS.Timeout | null = null
  counters = { admitted: 0, rejectedNoSlot: 0, refusals: 0, completed: 0, cancelled: 0, crashes: 0, tokens: 0, hits: 0, misses: 0, groups: 0 }

  constructor(public settings: EngineSettings) {}

  /** Slots unavailable to new work. Static batching holds them all until the group finishes. */
  slotsInUse(): number {
    if (this.settings.batching === 'static') return this.seqs.size > 0 ? this.settings.slots : 0
    return this.seqs.size
  }

  freeSlots(): number {
    return Math.max(0, this.settings.slots - this.slotsInUse())
  }

  /** Consumes one charge of an armed failure. */
  fire(kind: ChaosKind): boolean {
    if (this.chaos[kind] > 0) {
      this.chaos[kind]--
      return true
    }
    return false
  }

  /**
   * Admits as many items as there are free slots; the rest are rejected with
   * `no_slot` so the dispatcher can re-route them. Throws Refusal when the
   * whole group is refused (draining, restarting, chaos).
   */
  admit(groupId: string, items: EngineItem[], sink: GroupSink, now: number): { admitted: string[]; rejected: { id: string; reason: string }[] } {
    if (this.state === 'restarting') throw this.refuse(503, 'restarting')
    if (this.state === 'draining') throw this.refuse(503, 'draining')
    if (this.fire('overload')) throw this.refuse(529, 'overloaded')
    if (this.fire('refuse')) throw this.refuse(503, 'refused')

    const free = this.freeSlots()
    const admitted: string[] = []
    const rejected: { id: string; reason: string }[] = []
    for (const item of items) {
      if (this.seqs.has(item.id)) {
        rejected.push({ id: item.id, reason: 'duplicate' })
        continue
      }
      if (admitted.length >= free) {
        rejected.push({ id: item.id, reason: 'no_slot' })
        this.counters.rejectedNoSlot++
        continue
      }
      const cachedTokens = this.lookupCache(item)
      const slow = this.fire('slow') ? this.settings.slowExtraMs : 0
      const prefillMs = this.settings.ttftMs + (item.inputTokens - cachedTokens) * this.settings.prefillMsPerToken + slow
      const target = Math.max(1, Math.min(item.maxTokens, item.outputTokens ?? naturalLength(item.seed)))
      this.seqs.set(item.id, {
        item,
        groupId,
        target,
        readyAt: now + prefillMs,
        decoding: false,
        emitted: 0,
        cachedTokens,
        crashAt: this.fire('crash_mid_stream') ? Math.min(this.settings.crashAfterTokens, Math.max(1, target - 1)) : null,
        next: tokenStream(item.seed),
      })
      admitted.push(item.id)
    }
    if (admitted.length > 0) {
      this.groups.set(groupId, { ids: new Set(admitted), sink })
      this.stall += this.settings.admitOverheadMs
      this.counters.admitted += admitted.length
      this.counters.groups++
    }
    return { admitted, rejected }
  }

  private refuse(status: 503 | 529, reason: Refusal['reason']): Refusal {
    this.counters.refusals++
    return new Refusal(status, reason)
  }

  private lookupCache(item: EngineItem): number {
    if (item.prefixTokens <= 0) return 0
    const hit = this.cache.has(item.prefixKey)
    this.cache.delete(item.prefixKey)
    this.cache.set(item.prefixKey, item.prefixTokens)
    while (this.cache.size > this.settings.cacheEntries) {
      const oldest = this.cache.keys().next().value as string
      this.cache.delete(oldest)
    }
    this.window.push(hit)
    if (this.window.length > 200) this.window.shift()
    if (hit) this.counters.hits++
    else this.counters.misses++
    return hit ? Math.min(item.prefixTokens, item.inputTokens) : 0
  }

  /** Milliseconds until the next iteration should run (includes admission stalls). */
  nextPeriod(): number {
    const period = 1000 / this.settings.tokensPerSecond + this.stall
    this.stall = 0
    return period
  }

  /** One decode iteration at time `now`. */
  step(now: number): void {
    const out = new Map<string, EngineEvent[]>()
    const push = (groupId: string, ev: EngineEvent) => {
      const list = out.get(groupId)
      if (list) list.push(ev)
      else out.set(groupId, [ev])
    }
    const finished: string[] = []
    let crash = false
    for (const [id, seq] of this.seqs) {
      if (!seq.decoding) {
        if (now < seq.readyAt) continue
        seq.decoding = true
        seq.emitted = 1
        push(seq.groupId, { t: 'first', id, text: seq.next(), cachedTokens: seq.cachedTokens, inputTokens: seq.item.inputTokens, version: this.settings.version })
      } else {
        seq.emitted++
        push(seq.groupId, { t: 'tok', id, text: seq.next() })
      }
      this.counters.tokens++
      if (seq.crashAt !== null && seq.emitted >= seq.crashAt) {
        crash = true
        break
      }
      if (seq.emitted >= seq.target) {
        push(seq.groupId, { t: 'done', id, outputTokens: seq.emitted, stopReason: seq.emitted >= seq.item.maxTokens ? 'max_tokens' : 'end_turn' })
        finished.push(id)
      }
    }
    // Tokens produced before the crash still reach the wire, as they would from a real server.
    for (const [groupId, events] of out) this.groups.get(groupId)?.sink.write(events)
    if (crash) {
      this.crash()
      return
    }
    for (const id of finished) {
      this.counters.completed++
      this.remove(id)
    }
    this.maybeFinishUpgrade()
  }

  /** Cancels sequences (dispatcher request). Returns the ids it was running. */
  cancel(ids: string[]): string[] {
    const hit: string[] = []
    for (const id of ids) {
      const seq = this.seqs.get(id)
      if (!seq) continue
      this.groups.get(seq.groupId)?.sink.write([{ t: 'cancelled', id, outputTokens: seq.emitted }])
      this.counters.cancelled++
      this.remove(id)
      hit.push(id)
    }
    this.maybeFinishUpgrade()
    return hit
  }

  /** The dispatcher's connection for a group went away: stop its work and free the slots. */
  abandonGroup(groupId: string): void {
    const group = this.groups.get(groupId)
    if (!group) return
    this.groups.delete(groupId)
    for (const id of group.ids) {
      if (this.seqs.delete(id)) this.counters.cancelled++
    }
    this.maybeFinishUpgrade()
  }

  private remove(id: string): void {
    const seq = this.seqs.get(id)
    if (!seq) return
    this.seqs.delete(id)
    const group = this.groups.get(seq.groupId)
    if (!group) return
    group.ids.delete(id)
    if (group.ids.size === 0) {
      this.groups.delete(seq.groupId)
      group.sink.end()
    }
  }

  /** Simulated process crash: every open stream drops, state and cache are lost, then a restart. */
  crash(): void {
    this.counters.crashes++
    const groups = [...this.groups.values()]
    this.groups.clear()
    this.seqs.clear()
    this.cache.clear()
    this.window = []
    this.state = 'restarting'
    for (const g of groups) g.sink.destroy()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.state = 'ok'
      if (this.targetVersion) this.finishUpgrade()
    }, this.settings.restartMs)
    this.restartTimer.unref?.()
  }

  setDraining(draining: boolean): void {
    if (this.state === 'restarting') return
    this.state = draining ? 'draining' : 'ok'
    if (!draining) this.targetVersion = null
  }

  /** Rolling upgrade of this replica: drain, wait for in-flight work, switch version, cold cache. */
  upgrade(version: string): void {
    this.targetVersion = version
    if (this.state !== 'restarting') this.state = 'draining'
    this.maybeFinishUpgrade()
  }

  private maybeFinishUpgrade(): void {
    if (this.targetVersion && this.state === 'draining' && this.seqs.size === 0) this.finishUpgrade()
  }

  private finishUpgrade(): void {
    this.settings.version = this.targetVersion as string
    this.targetVersion = null
    this.cache.clear()
    this.window = []
    this.state = 'ok'
  }

  hitRate(): number | null {
    if (this.window.length === 0) return null
    return this.window.filter(Boolean).length / this.window.length
  }

  snapshot() {
    let prefilling = 0
    for (const s of this.seqs.values()) if (!s.decoding) prefilling++
    return {
      status: this.state,
      model: this.settings.model,
      version: this.settings.version,
      targetVersion: this.targetVersion,
      batching: this.settings.batching,
      slots: this.settings.slots,
      inUse: this.slotsInUse(),
      active: this.seqs.size,
      prefilling,
      decoding: this.seqs.size - prefilling,
      cache: { entries: this.cache.size, capacity: this.settings.cacheEntries, hitRate: this.hitRate(), hits: this.counters.hits, misses: this.counters.misses },
      chaos: { ...this.chaos },
      settings: {
        ttftMs: this.settings.ttftMs,
        prefillMsPerToken: this.settings.prefillMsPerToken,
        tokensPerSecond: this.settings.tokensPerSecond,
        admitOverheadMs: this.settings.admitOverheadMs,
        crashAfterTokens: this.settings.crashAfterTokens,
      },
      counters: { ...this.counters },
    }
  }

  stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
  }
}
