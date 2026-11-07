/**
 * Event batching with retries.
 *
 * Events are grouped into batches; a batch gets its id when it is formed and
 * keeps that id and its events through every retry, so the server can
 * acknowledge a re-sent batch as a duplicate instead of counting it twice.
 * Pending events and unsent batches are persisted, so a crash or a closed tab
 * re-sends them on the next start (again with the same batch ids).
 * @module client/events
 */
import { shortId } from './ids.js'
import type { StorageAdapter } from './storage.js'

export interface ExposureEvent {
  type: 'exposure' | 'assignment'
  eventId: string
  ts: number
  flagKey: string
  flagVersion: number
  variant: string
  unitType: 'user' | 'org' | 'anonymous'
  unitId: string
  anonymousId?: string
  userId?: string
  stableId?: string
  orgId?: string
}

export interface ConversionEvent {
  type: 'conversion'
  eventId: string
  ts: number
  name: string
  value?: number
  anonymousId?: string
  userId?: string
  stableId?: string
  orgId?: string
}

export type SdkEvent = ExposureEvent | ConversionEvent

export interface Batch {
  batchId: string
  events: SdkEvent[]
  attempts: number
  nextAttemptAt: number
}

/** ok: delivered (or a duplicate). retry: transient failure. drop: the server rejected it for good. */
export type SendResult = 'ok' | 'retry' | 'drop'

export interface QueueOptions {
  send: (batch: Batch) => Promise<SendResult>
  storage: StorageAdapter
  storageKey: string
  maxBatchSize: number
  flushIntervalMs: number
  now: () => number
  /** Batches older than this many attempts are dropped (and counted). */
  maxAttempts?: number
  onChange?: () => void
}

export interface QueueStats {
  pending: number
  batches: number
  sent: number
  retried: number
  dropped: number
}

export class EventQueue {
  private pending: SdkEvent[] = []
  private batches: Batch[] = []
  private flushing: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  readonly stats: QueueStats = { pending: 0, batches: 0, sent: 0, retried: 0, dropped: 0 }

  constructor(private readonly opts: QueueOptions) {
    this.restore()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  push(event: SdkEvent): void {
    this.pending.push(event)
    this.persist()
    if (this.pending.length >= this.opts.maxBatchSize) void this.flush()
  }

  /** Forms batches from pending events and sends every batch that is due. Concurrent calls share one run. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.run().finally(() => {
        this.flushing = null
      })
    }
    return this.flushing
  }

  private formBatches(): void {
    while (this.pending.length > 0) {
      const events = this.pending.splice(0, this.opts.maxBatchSize)
      this.batches.push({ batchId: shortId('b_'), events, attempts: 0, nextAttemptAt: 0 })
    }
  }

  private async run(): Promise<void> {
    this.formBatches()
    this.persist()
    for (const batch of [...this.batches]) {
      if (batch.nextAttemptAt > this.opts.now()) continue
      let result: SendResult
      try {
        result = await this.opts.send(batch)
      } catch {
        result = 'retry'
      }
      if (result === 'ok' || result === 'drop') {
        this.batches = this.batches.filter((b) => b !== batch)
        if (result === 'ok') this.stats.sent += batch.events.length
        else this.stats.dropped += batch.events.length
      } else {
        batch.attempts++
        this.stats.retried++
        if (batch.attempts >= (this.opts.maxAttempts ?? 20)) {
          this.batches = this.batches.filter((b) => b !== batch)
          this.stats.dropped += batch.events.length
        } else {
          // Exponential backoff with full jitter, capped at 30 s.
          const cap = Math.min(30_000, 1_000 * 2 ** (batch.attempts - 1))
          batch.nextAttemptAt = this.opts.now() + Math.floor(cap / 2 + Math.random() * (cap / 2))
        }
      }
      this.persist()
    }
  }

  /** Everything not yet acknowledged, as batches (for an unload beacon). They stay queued until acknowledged. */
  drainForBeacon(): Batch[] {
    this.formBatches()
    this.persist()
    return [...this.batches]
  }

  size(): number {
    return this.pending.length + this.batches.reduce((n, b) => n + b.events.length, 0)
  }

  private persist(): void {
    this.stats.pending = this.pending.length
    this.stats.batches = this.batches.length
    this.opts.onChange?.()
    if (this.opts.storage.persistent === false) return
    this.opts.storage.set(this.opts.storageKey, JSON.stringify({ pending: this.pending, batches: this.batches.map((b) => ({ ...b, nextAttemptAt: 0 })) }))
  }

  private restore(): void {
    const raw = this.opts.storage.get(this.opts.storageKey)
    if (!raw) return
    try {
      const saved = JSON.parse(raw) as { pending?: SdkEvent[]; batches?: Batch[] }
      this.pending = Array.isArray(saved.pending) ? saved.pending : []
      this.batches = Array.isArray(saved.batches) ? saved.batches : []
    } catch {
      this.opts.storage.remove(this.opts.storageKey)
    }
  }
}
