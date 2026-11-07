/**
 * Mock receiver state: per-path fault toggles, the dedupe store and the log of
 * what arrived. Pure and in memory, so it is unit-testable; a restart forgets
 * everything (a real receiver keeps processed event ids in its database with
 * a unique constraint).
 * @module receiver/state
 */
import { z } from 'zod'

export const MODES = ['ok', 'slow', 'error500', 'drop_ack', 'gone410', 'rate429'] as const
export type Mode = (typeof MODES)[number]

export interface PathConfig {
  name: string
  /** Fault to apply. `ok` answers 200 after verifying and deduping. */
  mode: Mode
  /** Requests the fault applies to before reverting to `ok`; null = until changed. */
  remaining: number | null
  /** `slow`: delay before answering. `drop_ack`: delay before dropping the socket. */
  slowMs: number
  /** `rate429`: the Retry-After value sent. */
  retryAfterSeconds: number
  /** When set, the only secrets this path accepts (simulates a receiver that hasn't picked up a rotation). */
  pinnedSecrets: string[] | null
}

export const pathPatchSchema = z
  .object({
    mode: z.enum(MODES),
    remaining: z.number().int().min(1).max(1000).nullable(),
    slowMs: z.number().int().min(0).max(120_000),
    retryAfterSeconds: z.number().int().min(0).max(3600),
    pinnedSecrets: z.array(z.string().min(1)).max(4).nullable(),
  })
  .partial()
  .strict()

export type PathPatch = z.infer<typeof pathPatchSchema>

export interface ReceivedEntry {
  seq: number
  path: string
  receivedAt: string
  eventId: string | null
  deliveryId: string | null
  type: string | null
  attempt: number | null
  orderingKey: string | null
  sequence: number | null
  signatureValid: boolean | null
  signatureReason: string | null
  signaturesPresented: number
  /** Already processed this event id: acknowledged again but not re-applied. */
  duplicate: boolean
  /** A higher sequence for this ordering key was already applied: discarded. */
  stale: boolean
  /** The handler ran (the event was "applied" or recognised as a duplicate). */
  processed: boolean
  fault: Mode
  responseStatus: number | null
  note: string
}

export function defaultPath(name: string): PathConfig {
  return { name, mode: 'ok', remaining: null, slowMs: 8000, retryAfterSeconds: 5, pinnedSecrets: null }
}

export class ReceiverState {
  private paths = new Map<string, PathConfig>()
  private seen = new Map<string, Map<string, number>>()
  private maxSeq = new Map<string, number>()
  private log: ReceivedEntry[] = []
  private nextSeq = 1
  private active = new Map<string, number>()
  private peak = new Map<string, number>()

  constructor(private maxLog = 3000) {}

  path(name: string): PathConfig {
    let p = this.paths.get(name)
    if (!p) {
      p = defaultPath(name)
      this.paths.set(name, p)
    }
    return p
  }

  /** Concurrent open requests per path: what the customer's server actually feels. */
  begin(path: string): void {
    const n = (this.active.get(path) ?? 0) + 1
    this.active.set(path, n)
    this.peak.set(path, Math.max(n, this.peak.get(path) ?? 0))
  }

  end(path: string): void {
    this.active.set(path, Math.max(0, (this.active.get(path) ?? 1) - 1))
  }

  concurrency(path: string): { inProgress: number; peakInProgress: number } {
    return { inProgress: this.active.get(path) ?? 0, peakInProgress: this.peak.get(path) ?? 0 }
  }

  listPaths(): PathConfig[] {
    return [...this.paths.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  update(name: string, patch: PathPatch): PathConfig {
    const p = this.path(name)
    Object.assign(p, patch)
    if (patch.mode === 'ok') p.remaining = null
    return p
  }

  /** The fault for this request, consuming one armed use. */
  takeFault(name: string): Mode {
    const p = this.path(name)
    if (p.mode === 'ok') return 'ok'
    const mode = p.mode
    if (p.remaining !== null) {
      p.remaining -= 1
      if (p.remaining <= 0) {
        p.mode = 'ok'
        p.remaining = null
      }
    }
    return mode
  }

  /** Records an event id as processed; true if it had been seen before. */
  markSeen(path: string, eventId: string): boolean {
    let m = this.seen.get(path)
    if (!m) {
      m = new Map()
      this.seen.set(path, m)
    }
    const count = m.get(eventId) ?? 0
    m.set(eventId, count + 1)
    return count > 0
  }

  /** Applies a per-key sequence; true if it is older than one already applied. */
  checkStale(path: string, orderingKey: string, sequence: number): boolean {
    const k = `${path}\u0000${orderingKey}`
    const max = this.maxSeq.get(k) ?? 0
    if (sequence < max) return true
    this.maxSeq.set(k, sequence)
    return false
  }

  add(entry: Omit<ReceivedEntry, 'seq'>): ReceivedEntry {
    const e = { ...entry, seq: this.nextSeq++ }
    this.log.push(e)
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog)
    return e
  }

  setStatus(seq: number, status: number | null, note?: string): void {
    const e = this.log.find((x) => x.seq === seq)
    if (e) {
      e.responseStatus = status
      if (note) e.note = note
    }
  }

  received(paths: string[] | null, limit = 200): ReceivedEntry[] {
    const rows = paths ? this.log.filter((e) => paths.includes(e.path)) : this.log
    return rows.slice(-limit).reverse()
  }

  stats(paths: string[] | null) {
    const rows = paths ? this.log.filter((e) => paths.includes(e.path)) : this.log
    const unique = new Set(rows.filter((e) => e.processed && e.eventId).map((e) => `${e.path}:${e.eventId}`))
    return {
      requests: rows.length,
      processed: rows.filter((e) => e.processed).length,
      uniqueEvents: unique.size,
      duplicates: rows.filter((e) => e.duplicate).length,
      badSignatures: rows.filter((e) => e.signatureValid === false).length,
      stale: rows.filter((e) => e.stale).length,
    }
  }

  clear(paths: string[] | null): void {
    if (!paths) {
      this.log = []
      this.seen.clear()
      this.maxSeq.clear()
      this.peak.clear()
      return
    }
    for (const p of paths) this.peak.delete(p)
    this.log = this.log.filter((e) => !paths.includes(e.path))
    for (const p of paths) this.seen.delete(p)
    for (const k of [...this.maxSeq.keys()]) if (paths.some((p) => k.startsWith(`${p}\u0000`))) this.maxSeq.delete(k)
  }
}
