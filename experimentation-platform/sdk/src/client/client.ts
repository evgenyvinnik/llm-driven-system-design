/**
 * The SDK client. Environment-neutral (browser and Node): storage, fetch and
 * the unload beacon are injected; client/browser wires them to localStorage,
 * window.fetch and navigator.sendBeacon.
 *
 * Evaluation is always local and synchronous, from the snapshot held in
 * memory. Where that snapshot comes from, in order of preference:
 *   1. the network (latest, revalidated with If-None-Match; then pushed versions)
 *   2. a bootstrap snapshot passed in by the host (e.g. server-rendered)
 *   3. the last known good snapshot from storage (if younger than maxCacheAgeMs)
 *   4. nothing: every key gets its safe coded default (reason "default")
 * The network is never on the render path: ready() resolves after the first
 * fetch or after initTimeoutMs, whichever comes first.
 *
 * Exposure is logged only by logExposure (called when the treatment actually
 * renders, see react/Exposure), only for in-experiment evaluations, once per
 * unit per experiment per config version.
 * @module client/client
 */
import { evaluate as coreEvaluate, resolveUnit } from '../core/evaluate.js'
import type { EvalContext, Evaluation, Snapshot } from '../core/types.js'
import { EventQueue, type Batch, type ExposureEvent, type SdkEvent, type SendResult } from './events.js'
import { shortId, uuid } from './ids.js'
import { readStream } from './sse.js'
import { noopStorage, safeStorage, type StorageAdapter } from './storage.js'

export type SnapshotSource = 'network' | 'bootstrap' | 'cache' | 'defaults'
export type Connection = 'connecting' | 'live' | 'polling' | 'offline' | 'closed'

export interface ClientOptions {
  /** Base URL of the SDK API, e.g. "/sdk/v1" or "https://flags.example.com/sdk/v1". */
  apiUrl: string
  clientKey: string
  /** Safe coded defaults (flag key → variant) used when no snapshot is available at all. */
  defaults?: Record<string, string>
  bootstrap?: Snapshot | null
  /** Where to keep the last known good snapshot, dedup keys and unsent events (none by default). */
  storage?: StorageAdapter | null
  fetch?: typeof fetch
  /** Sends a body with navigator.sendBeacon (browsers); returns false if it could not queue it. */
  beacon?: (url: string, body: string) => boolean
  stream?: boolean
  pollIntervalMs?: number
  initTimeoutMs?: number
  requestTimeoutMs?: number
  flushIntervalMs?: number
  maxBatchSize?: number
  /** A cached snapshot older than this is ignored at startup (defaults are safer than a week-old ruleset). */
  maxCacheAgeMs?: number
  /** Log assignment events (diagnostic: the results page compares them with exposures). */
  logAssignments?: boolean
  reportIntervalMs?: number
  sdkInstanceId?: string
  label?: string
  context?: EvalContext
  now?: () => number
  onError?: (err: Error) => void
}

export interface ClientState {
  version: number
  source: SnapshotSource
  connection: Connection
  context: EvalContext
  lastError: string | null
  lastUpdateAt: number | null
  /** Bumps on every change; React re-evaluates when it moves. */
  revision: number
  queued: number
  exposuresLogged: number
}

interface StoredSnapshot {
  savedAt: number
  etag: string | null
  snapshot: Snapshot
}

type Listener = () => void

export class ExperimentClient {
  private snapshot: Snapshot | null = null
  private etag: string | null = null
  private readonly opts: Required<Omit<ClientOptions, 'bootstrap' | 'storage' | 'beacon' | 'onError' | 'context' | 'defaults' | 'label' | 'sdkInstanceId'>> &
    Pick<ClientOptions, 'beacon' | 'onError'>
  private readonly storage: StorageAdapter
  private readonly queue: EventQueue
  private readonly listeners = new Set<Listener>()
  private readonly defaults: Record<string, string>
  private readonly exposed: Set<string>
  private readonly assigned: Set<string>
  private state: ClientState
  private abort = new AbortController()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private readyPromise: Promise<SnapshotSource> | null = null
  private firstFetch: Promise<void> | null = null
  readonly sdkInstanceId: string
  readonly label: string

  constructor(options: ClientOptions) {
    this.opts = {
      apiUrl: options.apiUrl.replace(/\/$/, ''),
      clientKey: options.clientKey,
      fetch: options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
      stream: options.stream ?? true,
      pollIntervalMs: options.pollIntervalMs ?? 30_000,
      initTimeoutMs: options.initTimeoutMs ?? 1_500,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      flushIntervalMs: options.flushIntervalMs ?? 2_000,
      maxBatchSize: options.maxBatchSize ?? 50,
      maxCacheAgeMs: options.maxCacheAgeMs ?? 7 * 86_400_000,
      logAssignments: options.logAssignments ?? true,
      reportIntervalMs: options.reportIntervalMs ?? 15_000,
      now: options.now ?? (() => Date.now()),
      beacon: options.beacon,
      onError: options.onError,
    }
    this.defaults = options.defaults ?? {}
    this.storage = safeStorage(options.storage ?? noopStorage())
    this.sdkInstanceId = options.sdkInstanceId ?? shortId('sdk_')
    this.label = options.label ?? this.sdkInstanceId
    this.exposed = new Set(this.loadKeys('exposed'))
    this.assigned = new Set(this.loadKeys('assigned'))
    this.queue = new EventQueue({
      send: (batch) => this.sendBatch(batch),
      storage: this.storage,
      storageKey: this.key('events'),
      maxBatchSize: this.opts.maxBatchSize,
      flushIntervalMs: this.opts.flushIntervalMs,
      now: this.opts.now,
      onChange: () => this.patch({ queued: this.queue?.size() ?? 0 }, false),
    })

    let source: SnapshotSource = 'defaults'
    const cached = this.loadCached()
    if (options.bootstrap && options.bootstrap.schema === 1) {
      this.snapshot = options.bootstrap
      source = 'bootstrap'
    }
    if (cached && (!this.snapshot || cached.snapshot.version > this.snapshot.version)) {
      this.snapshot = cached.snapshot
      this.etag = cached.etag
      source = 'cache'
    }
    this.state = {
      version: this.snapshot?.version ?? 0,
      source,
      connection: 'connecting',
      context: options.context ?? {},
      lastError: null,
      lastUpdateAt: null,
      revision: 0,
      queued: this.queue.size(),
      exposuresLogged: 0,
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Starts fetching, streaming, flushing and reporting. Idempotent. Resolves like ready(). */
  start(): Promise<SnapshotSource> {
    if (!this.started) {
      this.started = true
      this.queue.start()
      this.firstFetch = this.fetchLatest().catch(() => undefined)
      if (this.opts.stream) void this.streamLoop()
      else this.schedulePoll()
      this.reportTimer = setInterval(() => void this.report(), this.opts.reportIntervalMs)
      ;(this.reportTimer as { unref?: () => void }).unref?.()
      void this.queue.flush()
    }
    return this.ready()
  }

  /**
   * Resolves with the snapshot source once the first network fetch finishes or
   * initTimeoutMs passes, whichever is first. Never rejects: on timeout or
   * failure the client keeps serving its cache or the coded defaults.
   */
  ready(): Promise<SnapshotSource> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(this.state.source), this.opts.initTimeoutMs)
        void (this.firstFetch ?? Promise.resolve()).then(() => {
          clearTimeout(timer)
          resolve(this.state.source)
        })
      })
    }
    return this.readyPromise
  }

  /** Stops network activity after a final flush attempt. */
  async close(): Promise<void> {
    this.abort.abort()
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.reportTimer) clearInterval(this.reportTimer)
    this.queue.stop()
    await this.queue.flush().catch(() => undefined)
    this.patch({ connection: 'closed' })
  }

  // ── state for UIs ────────────────────────────────────────────────────────

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): ClientState => this.state

  getSnapshot(): Snapshot | null {
    return this.snapshot
  }

  private patch(change: Partial<ClientState>, bump = true): void {
    this.state = { ...this.state, ...change, revision: bump ? this.state.revision + 1 : this.state.revision }
    for (const l of this.listeners) l()
  }

  // ── identity ─────────────────────────────────────────────────────────────

  setContext(context: EvalContext): void {
    this.patch({ context })
  }

  /** After sign-in: the host passes the stable id its server got from /identify. */
  identify(change: { userId: string; stableId?: string; orgId?: string; attributes?: Record<string, string | undefined> }): void {
    const ctx = this.state.context
    this.setContext({
      ...ctx,
      userId: change.userId,
      // Until the alias is confirmed, keep bucketing by the current stable id (the anonymous id): no flip.
      stableId: change.stableId ?? ctx.stableId ?? ctx.anonymousId,
      orgId: change.orgId ?? ctx.orgId,
      attributes: { ...ctx.attributes, ...change.attributes },
    })
  }

  // ── evaluation ───────────────────────────────────────────────────────────

  /** Pure evaluation: no events. */
  peek(key: string, ctx: EvalContext = this.state.context): Evaluation {
    const result = coreEvaluate(this.snapshot, key, ctx)
    if (result.reason !== 'unknown_flag') return result
    const fallback = this.defaults[key]
    return { key, variant: fallback ?? null, value: undefined, reason: 'default', inExperiment: false }
  }

  /** Evaluation plus an assignment event (deduped). Use where the app asks for a variant. */
  evaluate(key: string, ctx: EvalContext = this.state.context): Evaluation {
    const result = this.peek(key, ctx)
    this.recordAssignment(result, ctx)
    return result
  }

  /** Every flag in the snapshot, as an app does at session start. Logs assignments (not exposures). */
  evaluateAll(ctx: EvalContext = this.state.context): Record<string, Evaluation> {
    const keys = new Set([...Object.keys(this.snapshot?.flags ?? {}), ...Object.keys(this.defaults)])
    return Object.fromEntries([...keys].map((k) => [k, this.evaluate(k, ctx)]))
  }

  recordAssignment(result: Evaluation, ctx: EvalContext = this.state.context): void {
    if (!this.opts.logAssignments || !result.inExperiment) return
    const dedup = `${result.key}:${result.version}:${result.unitId}`
    if (this.assigned.has(dedup)) return
    this.assigned.add(dedup)
    this.saveKey('assigned', this.assigned, dedup)
    this.queue.push(this.exposureEvent('assignment', result, ctx))
  }

  /**
   * Call when the variant actually rendered. Logs at most one exposure per
   * unit per experiment per config version; never for defaults, forced or
   * excluded units, or flags. Returns whether an event was queued.
   */
  logExposure(result: Evaluation, ctx: EvalContext = this.state.context): boolean {
    if (!result.inExperiment || !result.variant || !result.unitId) return false
    const dedup = `${result.key}:${result.version}:${result.unitId}`
    if (this.exposed.has(dedup)) return false
    this.exposed.add(dedup)
    this.saveKey('exposed', this.exposed, dedup)
    this.queue.push(this.exposureEvent('exposure', result, ctx))
    this.patch({ exposuresLogged: this.state.exposuresLogged + 1 }, false)
    return true
  }

  /** Conversion tracking. `ts` exists for backfills and simulations; apps omit it. */
  track(name: string, props: { value?: number; ts?: number } = {}, ctx: EvalContext = this.state.context): void {
    this.queue.push({
      type: 'conversion',
      eventId: uuid(),
      ts: props.ts ?? this.opts.now(),
      name,
      ...(props.value !== undefined ? { value: props.value } : {}),
      ...ids(ctx),
    })
  }

  hasExposed(result: Evaluation): boolean {
    return this.exposed.has(`${result.key}:${result.version}:${result.unitId}`)
  }

  private exposureEvent(type: 'exposure' | 'assignment', result: Evaluation, ctx: EvalContext): ExposureEvent {
    return {
      type,
      eventId: uuid(),
      ts: this.opts.now(),
      flagKey: result.key,
      flagVersion: result.version ?? 1,
      variant: result.variant as string,
      unitType: result.unitType ?? 'user',
      unitId: result.unitId ?? resolveUnit(result.unitType ?? 'user', ctx) ?? '',
      ...ids(ctx),
    }
  }

  // ── events ───────────────────────────────────────────────────────────────

  flush(): Promise<void> {
    return this.queue.flush()
  }

  /** On pagehide / visibility hidden: hand everything unacknowledged to the beacon. */
  flushOnUnload(): void {
    if (!this.opts.beacon) return
    const url = `${this.opts.apiUrl}/events?key=${encodeURIComponent(this.opts.clientKey)}`
    for (const batch of this.queue.drainForBeacon()) {
      this.opts.beacon(url, JSON.stringify(this.envelope(batch)))
    }
  }

  private envelope(batch: Batch) {
    return { batchId: batch.batchId, sentAt: this.opts.now(), sdkInstanceId: this.sdkInstanceId, clientKey: this.opts.clientKey, events: batch.events as SdkEvent[] }
  }

  private async sendBatch(batch: Batch): Promise<SendResult> {
    try {
      const res = await this.request(`${this.opts.apiUrl}/events`, { method: 'POST', body: JSON.stringify(this.envelope(batch)) })
      if (res.ok) return 'ok'
      if (res.status === 408 || res.status === 429 || res.status >= 500) return 'retry'
      return 'drop'
    } catch {
      return 'retry'
    }
  }

  // ── snapshot transport ───────────────────────────────────────────────────

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.opts.requestTimeoutMs)
    const onAbort = () => timeout.abort()
    this.abort.signal.addEventListener('abort', onAbort)
    try {
      return await this.opts.fetch(url, {
        ...init,
        headers: { 'X-Client-Key': this.opts.clientKey, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...((init.headers as Record<string, string>) ?? {}) },
        signal: timeout.signal,
      })
    } finally {
      clearTimeout(timer)
      this.abort.signal.removeEventListener('abort', onAbort)
    }
  }

  /** GET the latest snapshot, revalidating with the held ETag (304 = keep). */
  async fetchLatest(): Promise<void> {
    try {
      const res = await this.request(`${this.opts.apiUrl}/snapshot`, { headers: this.etag ? { 'If-None-Match': this.etag } : {} })
      if (res.status === 304) {
        // The held (cached or bootstrapped) snapshot is confirmed current by the server.
        this.patch({ lastError: null, ...(this.snapshot ? { source: 'network' as const } : {}) })
        void this.report()
        return
      }
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`)
      this.apply((await res.json()) as Snapshot, res.headers.get('ETag'))
    } catch (err) {
      this.fail(err)
      throw err
    }
  }

  /** GET one immutable version (what a push names). */
  async fetchVersion(version: number): Promise<void> {
    if (this.snapshot && this.snapshot.version >= version) return
    try {
      const res = await this.request(`${this.opts.apiUrl}/snapshots/${version}`)
      if (!res.ok) throw new Error(`snapshot v${version} HTTP ${res.status}`)
      this.apply((await res.json()) as Snapshot, res.headers.get('ETag'))
    } catch (err) {
      this.fail(err)
      await this.fetchLatest().catch(() => undefined)
    }
  }

  /** Accepts a snapshot only if it is well formed, for this environment, and newer than the one held. */
  apply(next: Snapshot, etag: string | null): boolean {
    if (!next || next.schema !== 1 || typeof next.version !== 'number' || typeof next.flags !== 'object') {
      this.fail(new Error('malformed snapshot ignored'))
      return false
    }
    if (this.snapshot && this.snapshot.environment !== next.environment && this.state.source === 'network') {
      this.fail(new Error(`snapshot for ${next.environment} ignored (holding ${this.snapshot.environment})`))
      return false
    }
    const isNewer = !this.snapshot || next.version > this.snapshot.version
    if (isNewer) {
      this.snapshot = next
      this.etag = etag ?? `"${next.environment}-v${next.version}"`
      const stored: StoredSnapshot = { savedAt: this.opts.now(), etag: this.etag, snapshot: next }
      this.storage.set(this.key('snapshot'), JSON.stringify(stored))
    }
    this.patch({ version: this.snapshot!.version, source: 'network', lastError: null, lastUpdateAt: isNewer ? this.opts.now() : this.state.lastUpdateAt })
    void this.report()
    return isNewer
  }

  private fail(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))
    if (this.abort.signal.aborted) return
    this.patch({ lastError: error.message })
    this.opts.onError?.(error)
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(async () => {
      if (this.abort.signal.aborted) return
      if (this.state.connection !== 'live') {
        await this.fetchLatest().catch(() => undefined)
        if (!this.opts.stream) this.patch({ connection: this.state.lastError ? 'offline' : 'polling' })
      }
      this.schedulePoll()
    }, this.opts.pollIntervalMs)
    ;(this.pollTimer as { unref?: () => void }).unref?.()
  }

  private async streamLoop(): Promise<void> {
    let backoff = 1_000
    this.schedulePoll()
    while (!this.abort.signal.aborted) {
      const url = `${this.opts.apiUrl}/stream?sdk=${encodeURIComponent(this.sdkInstanceId)}&label=${encodeURIComponent(this.label)}&version=${this.snapshot?.version ?? 0}`
      try {
        await readStream(
          this.opts.fetch,
          url,
          { 'X-Client-Key': this.opts.clientKey },
          {
            onOpen: () => {
              backoff = 1_000
              this.patch({ connection: 'live', lastError: null })
            },
            onEvent: (e) => {
              if (e.event !== 'hello' && e.event !== 'snapshot') return
              const data = JSON.parse(e.data) as { version: number }
              if (!this.snapshot || data.version > this.snapshot.version) void this.fetchVersion(data.version)
            },
          },
          this.abort.signal,
          45_000,
        )
      } catch (err) {
        if (this.abort.signal.aborted) return
        this.fail(err)
      }
      if (this.abort.signal.aborted) return
      this.patch({ connection: this.state.lastError ? 'offline' : 'polling' })
      // Full jitter so a restarted API instance isn't hit by every client at once.
      await new Promise((r) => setTimeout(r, Math.random() * backoff))
      backoff = Math.min(30_000, backoff * 2)
      if (this.state.connection !== 'live') void this.fetchLatest().catch(() => undefined)
    }
  }

  /** Tells the server which version this instance holds (live client view, propagation timing). */
  private async report(): Promise<void> {
    if (!this.snapshot || this.abort.signal.aborted) return
    try {
      await this.request(`${this.opts.apiUrl}/clients/report`, {
        method: 'POST',
        body: JSON.stringify({ sdkInstanceId: this.sdkInstanceId, label: this.label, version: this.snapshot.version, source: this.state.source, transport: this.state.connection === 'live' ? 'sse' : 'poll' }),
      })
    } catch {
      // best effort
    }
  }

  // ── storage helpers ──────────────────────────────────────────────────────

  private key(name: string): string {
    return `exp:${this.opts.clientKey}:${name}`
  }

  private loadCached(): StoredSnapshot | null {
    const raw = this.storage.get(this.key('snapshot'))
    if (!raw) return null
    try {
      const stored = JSON.parse(raw) as StoredSnapshot
      if (stored.snapshot?.schema !== 1) return null
      if (this.opts.now() - stored.savedAt > this.opts.maxCacheAgeMs) return null
      return stored
    } catch {
      return null
    }
  }

  private loadKeys(name: string): string[] {
    try {
      const parsed = JSON.parse(this.storage.get(this.key(name)) ?? '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private readonly recentKeys: Record<string, string[]> = {}

  /**
   * Persists dedup keys, bounded: only the newest 1,000 are kept (a re-exposure
   * after that many others is harmless; the analysis counts distinct units).
   */
  private saveKey(name: string, set: Set<string>, added: string): void {
    if (!this.storage.persistent) return
    const recent = (this.recentKeys[name] ??= [...set].filter((k) => k !== added).slice(-999))
    recent.push(added)
    if (recent.length > 2_000) recent.splice(0, recent.length - 1_000)
    this.storage.set(this.key(name), JSON.stringify(recent.slice(-1_000)))
  }
}

function ids(ctx: EvalContext) {
  return {
    ...(ctx.anonymousId ? { anonymousId: ctx.anonymousId } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    ...(ctx.stableId || ctx.anonymousId ? { stableId: ctx.stableId || ctx.anonymousId } : {}),
    ...(ctx.orgId ? { orgId: ctx.orgId } : {}),
  }
}

export function createClient(options: ClientOptions): ExperimentClient {
  return new ExperimentClient(options)
}
