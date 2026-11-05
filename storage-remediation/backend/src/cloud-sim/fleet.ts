/**
 * The simulated control plane. Behaves like the parts of ARM, Resource Graph,
 * Azure Policy, Azure Monitor and Log Analytics that the remediation system
 * depends on, including the uncomfortable parts:
 * - per-subscription write and read token buckets that answer 429 + Retry-After
 * - a Resource Graph quota per principal and a lag between ARM writes and graph reads
 * - etags with If-Match preconditions (412 on mismatch)
 * - occasional 5xx on writes, half of which were applied anyway
 * - policy assignments whose deny/modify effects apply to every writer, including rollbacks
 * @module cloud-sim/fleet
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONTROLS, WORKSPACE_ID } from '../domain/controls.js'
import { accountResourceId, type AccountProperties, type PolicyEffect, type ResourceKind } from '../domain/types.js'
import { take, type BucketConfig, type BucketState } from '../shared/token-bucket.js'
import { etagFor, mulberry32, TEAMS } from './generate.js'
import { DEFAULT_FAULTS, type ChangeEvent, type Faults, type FleetState, type GraphView, type SimAccount, type SimClient, type SimStats, type Versioned } from './model.js'
import { logRows, transactionSeries, updateClientHealth, type LogRow } from './traffic.js'

export interface SimResponse {
  status: number
  headers?: Record<string, string>
  body: unknown
}

const CHANGE_RETENTION = 20_000
const POLICY_FIELDS: Record<string, string[]> = {
  'SA-01': ['allowBlobPublicAccess'],
  'SA-02': ['allowSharedKeyAccess'],
  'SA-03': ['minimumTlsVersion'],
  'SA-04': ['supportsHttpsTrafficOnly'],
  'SA-05': ['networkAcls', 'publicNetworkAccess'],
}

const ACCOUNT_PATH =
  /^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Storage\/storageAccounts\/[^/]+)(\/blobServices\/default)?(\/providers\/Microsoft\.Insights\/(diagnosticSettings\/[^/]+|metrics))?$/i

export function parseSimPath(path: string): { accountId: string; kind: ResourceKind | 'metrics' } | null {
  const m = ACCOUNT_PATH.exec(path)
  if (!m) return null
  if (m[4]?.toLowerCase() === 'metrics') return { accountId: m[1], kind: 'metrics' }
  if (m[4]) return m[2] ? { accountId: m[1], kind: 'diagnostics' } : null
  return { accountId: m[1], kind: m[2] ? 'blobService' : 'account' }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v
  return out as T
}

const error = (status: number, code: string, message: string, headers?: Record<string, string>): SimResponse => ({ status, headers, body: { error: { code, message } } })

export class Fleet {
  readonly stats: SimStats = { writes: 0, reads: 0, throttledWrites: 0, throttledReads: 0, throttledGraph: 0, throttledLogs: 0, errors5xx: 0, ambiguous5xx: 0, preconditionFailed: 0, deniedByPolicy: 0 }
  private buckets = new Map<string, BucketState>()
  private index = new Map<string, SimAccount>()
  /** Recent writes by client request ID: the simulator's stand-in for the activity log. */
  private operations = new Map<string, { resourceId: string; kind: ResourceKind; status: number; applied: boolean; at: string }>()
  dirty = false

  constructor(
    public state: FleetState,
    private clock: () => number = Date.now,
    private random: () => number = Math.random,
  ) {
    this.reindex()
  }

  private reindex(): void {
    this.index = new Map(this.state.accounts.map((a) => [a.id.toLowerCase(), a]))
  }

  get faults(): Faults {
    return { ...DEFAULT_FAULTS, ...this.state.faults }
  }

  setFaults(patch: Partial<Faults>): Faults {
    this.state.faults = { ...DEFAULT_FAULTS, ...this.state.faults, ...patch }
    this.dirty = true
    return this.state.faults
  }

  account(id: string): SimAccount | undefined {
    const a = this.index.get(id.toLowerCase())
    return a && !a.deleted ? a : undefined
  }

  /** Returns 0 when a token was taken, else milliseconds until one is available. */
  private throttle(key: string, cfg: BucketConfig): number {
    const result = take(this.buckets.get(key), cfg, this.clock())
    this.buckets.set(key, result.state)
    return result.ok ? 0 : result.waitMs
  }

  private remaining(key: string): number {
    return Math.floor(this.buckets.get(key)?.tokens ?? 0)
  }

  listSubscriptions(): SimResponse {
    return { status: 200, body: { value: this.state.subscriptions.map((s) => ({ ...s, id: `/subscriptions/${s.subscriptionId}`, state: 'Enabled' })) } }
  }

  /** What Resource Graph shows now: writes become visible only after the lag. */
  private graphView(a: SimAccount): GraphView {
    const now = this.clock()
    while (a.graph.pending.length > 0 && a.graph.pending[0].visibleAt <= now) {
      a.graph.current = a.graph.pending.shift()!.view
    }
    return a.graph.current
  }

  graphQuery(input: { subscriptions?: string[]; top?: number; skipToken?: string }, principal: string): SimResponse {
    const wait = this.throttle(`graph:${principal}`, { capacity: this.faults.graphCapacity, refillPerSec: this.faults.graphRefillPerSec })
    if (wait > 0) {
      this.stats.throttledGraph++
      const secs = Math.max(1, Math.ceil(wait / 1000))
      return error(429, 'RateLimiting', 'Resource Graph quota exceeded', { 'x-ms-user-quota-remaining': '0', 'x-ms-user-quota-resets-after': `00:00:${String(secs).padStart(2, '0')}` })
    }
    const subs = input.subscriptions && input.subscriptions.length > 0 ? new Set(input.subscriptions.map((s) => s.toLowerCase())) : null
    const rows = this.state.accounts
      .filter((a) => !a.deleted && (!subs || subs.has(a.subscriptionId.toLowerCase())))
      .sort((x, y) => x.id.localeCompare(y.id))
    const top = Math.min(Math.max(input.top ?? 500, 1), 1000)
    const offset = input.skipToken ? Number.parseInt(Buffer.from(input.skipToken, 'base64url').toString(), 10) || 0 : 0
    const page = rows.slice(offset, offset + top).map((a) => {
      const view = this.graphView(a)
      return {
        id: a.id,
        name: a.name,
        type: 'microsoft.storage/storageaccounts',
        location: a.location,
        resourceGroup: a.resourceGroup,
        subscriptionId: a.subscriptionId,
        tags: view.tags,
        properties: { ...view.props, creationTime: a.createdAt },
        systemData: { lastModifiedAt: view.lastModifiedAt },
      }
    })
    const next = offset + page.length < rows.length ? Buffer.from(String(offset + page.length)).toString('base64url') : undefined
    return {
      status: 200,
      headers: { 'x-ms-user-quota-remaining': String(this.remaining(`graph:${principal}`)) },
      body: { totalRecords: rows.length, count: page.length, data: page, $skipToken: next, resultTruncated: 'false' },
    }
  }

  private versioned(a: SimAccount, kind: ResourceKind): Versioned<unknown> {
    return kind === 'account' ? a.account : kind === 'blobService' ? a.blobService : a.diagnostics
  }

  private body(a: SimAccount, kind: ResourceKind): Record<string, unknown> {
    const v = this.versioned(a, kind)
    const systemData = { lastModifiedAt: v.lastModifiedAt }
    if (kind === 'account') {
      return { id: a.id, name: a.name, type: 'Microsoft.Storage/storageAccounts', kind: 'StorageV2', sku: { name: 'Standard_LRS' }, location: a.location, tags: a.tags, etag: v.etag, properties: { ...a.account.props, creationTime: a.createdAt }, systemData }
    }
    if (kind === 'blobService') {
      return { id: `${a.id}/blobServices/default`, name: 'default', type: 'Microsoft.Storage/storageAccounts/blobServices', etag: v.etag, properties: v.props, systemData }
    }
    return { id: `${a.id}/blobServices/default/providers/Microsoft.Insights/diagnosticSettings/storage-logs`, name: 'storage-logs', type: 'Microsoft.Insights/diagnosticSettings', etag: v.etag, properties: v.props, systemData }
  }

  getResource(path: string): SimResponse {
    const parsed = parseSimPath(path)
    if (!parsed || parsed.kind === 'metrics') return error(404, 'NotFound', 'Unknown resource path')
    const a = this.account(parsed.accountId)
    if (!a) return error(404, 'ResourceNotFound', `Storage account not found`)
    const wait = this.throttle(`read:${a.subscriptionId}`, { capacity: this.faults.readCapacity, refillPerSec: this.faults.readRefillPerSec })
    if (wait > 0) {
      this.stats.throttledReads++
      return error(429, 'TooManyRequests', 'Subscription read limit reached', { 'Retry-After': String(Math.max(1, Math.ceil(wait / 1000))), 'x-ms-ratelimit-remaining-subscription-reads': '0' })
    }
    this.stats.reads++
    const v = this.versioned(a, parsed.kind)
    return { status: 200, headers: { etag: v.etag, 'x-ms-ratelimit-remaining-subscription-reads': String(this.remaining(`read:${a.subscriptionId}`)) }, body: this.body(a, parsed.kind) }
  }

  /** Applies policy effects to an account write. Only controls whose fields the write touches are evaluated (creates evaluate all). */
  private applyPolicy(current: AccountProperties, patch: Record<string, unknown>, isCreate: boolean): { props?: AccountProperties; denied?: string; modified: string[] } {
    let merged = deepMerge(current, patch)
    const modified: string[] = []
    for (const control of CONTROLS) {
      const effect = this.state.policies[control.id]
      const fields = POLICY_FIELDS[control.id]
      if (!effect || !fields || effect === 'audit') continue
      if (!isCreate && !fields.some((f) => f in patch)) continue
      if (control.isCompliant(control.read(merged))) continue
      if (effect === 'deny') return { denied: `${control.id} ${control.policy.definition}`, modified }
      if (effect === 'modify') {
        merged = deepMerge(merged, control.desired(control.read(merged)).properties)
        modified.push(control.id)
      }
    }
    return { props: merged, modified }
  }

  private recordChange(a: SimAccount, kind: ResourceKind, changeType: ChangeEvent['changeType']): void {
    const now = this.clock()
    this.state.changes.push({ seq: this.state.nextSeq++, at: new Date(now).toISOString(), resourceId: a.id, subscriptionId: a.subscriptionId, kind, changeType })
    if (this.state.changes.length > CHANGE_RETENTION) this.state.changes.splice(0, this.state.changes.length - CHANGE_RETENTION)
  }

  private bump(a: SimAccount, kind: ResourceKind, props: unknown): void {
    const now = this.clock()
    const v = this.versioned(a, kind)
    v.props = props
    v.version += 1
    v.etag = etagFor(v.version, this.random)
    v.lastModifiedAt = new Date(now).toISOString()
    if (kind === 'account') {
      a.graph.pending.push({ visibleAt: now + this.faults.graphLagMs, view: { props: a.account.props, tags: { ...a.tags }, lastModifiedAt: v.lastModifiedAt } })
      updateClientHealth(a, now, this.faults.periodicJobsFireDuringBake ? this.faults.periodicFireDelayMs : null)
    }
    const key = `${a.id}|${kind}`
    this.state.writeCounts[key] = (this.state.writeCounts[key] ?? 0) + 1
    this.recordChange(a, kind, 'Update')
    this.dirty = true
  }

  private logOperation(operationId: string | undefined, resourceId: string, kind: ResourceKind, status: number, applied: boolean): void {
    if (!operationId) return
    this.operations.set(operationId, { resourceId, kind, status, applied, at: new Date(this.clock()).toISOString() })
    if (this.operations.size > 20_000) this.operations.delete(this.operations.keys().next().value!)
  }

  operation(operationId: string) {
    return this.operations.get(operationId) ?? null
  }

  writeResource(path: string, body: unknown, ifMatch: string | undefined, operationId?: string): SimResponse {
    const r = this.writeResourceInner(path, body, ifMatch)
    const parsed = parseSimPath(path)
    if (parsed && parsed.kind !== 'metrics') this.logOperation(operationId, parsed.accountId, parsed.kind, r.status, r.status === 200 || (r.body as { applied?: boolean })?.applied === true)
    if ((r.body as { applied?: boolean })?.applied !== undefined) delete (r.body as { applied?: boolean }).applied
    return r
  }

  private writeResourceInner(path: string, body: unknown, ifMatch: string | undefined): SimResponse {
    const parsed = parseSimPath(path)
    if (!parsed || parsed.kind === 'metrics') return error(404, 'NotFound', 'Unknown resource path')
    const a = this.account(parsed.accountId)
    if (!a) return error(404, 'ResourceNotFound', 'Storage account not found')
    const kind = parsed.kind
    const wait = this.throttle(`write:${a.subscriptionId}`, { capacity: this.faults.writeCapacity, refillPerSec: this.faults.writeRefillPerSec })
    if (wait > 0) {
      this.stats.throttledWrites++
      return error(429, 'TooManyRequests', 'Subscription write limit reached', { 'Retry-After': String(Math.max(1, Math.ceil(wait / 1000))), 'x-ms-ratelimit-remaining-subscription-writes': '0' })
    }
    const v = this.versioned(a, kind)
    if (ifMatch && ifMatch !== '*' && ifMatch !== v.etag) {
      this.stats.preconditionFailed++
      return error(412, 'PreconditionFailed', 'The resource was modified since it was read (etag mismatch)')
    }
    const patch = isPlainObject(body) && isPlainObject(body.properties) ? body.properties : {}
    let next: unknown
    if (kind === 'account') {
      const result = this.applyPolicy(a.account.props, patch, false)
      if (result.denied) {
        this.stats.deniedByPolicy++
        return error(403, 'RequestDisallowedByPolicy', `Resource was disallowed by policy: ${result.denied}`)
      }
      next = result.props
    } else {
      next = deepMerge(v.props, patch)
      if (kind === 'diagnostics') {
        const d = next as { enabled: boolean; createdAt: string | null }
        if (d.enabled && !(v.props as { enabled: boolean }).enabled) d.createdAt = new Date(this.clock()).toISOString()
        if (!d.enabled) d.createdAt = null
      }
    }
    if (this.random() < this.faults.error5xxRate) {
      this.stats.errors5xx++
      if (this.random() < this.faults.ambiguous5xxShare) {
        // Applied, but the caller never learns it: the reason every retry starts with a read.
        this.stats.ambiguous5xx++
        this.bump(a, kind, next)
        const lost = error(500, 'InternalServerError', 'An internal error occurred')
        return { ...lost, body: { ...(lost.body as object), applied: true } }
      }
      return error(503, 'ServiceUnavailable', 'The service is temporarily unavailable', { 'Retry-After': '1' })
    }
    this.bump(a, kind, next)
    this.stats.writes++
    return { status: 200, headers: { etag: v.etag, 'x-ms-ratelimit-remaining-subscription-writes': String(this.remaining(`write:${a.subscriptionId}`)) }, body: this.body(a, kind) }
  }

  changesSince(since: number, limit: number): SimResponse {
    const oldest = this.state.changes[0]?.seq ?? this.state.nextSeq
    const latest = this.state.nextSeq - 1
    if (since > latest || (since < oldest - 1 && this.state.changes.length > 0)) {
      const gone = error(410, 'CursorExpired', `Cursor ${since} is outside the retained feed (${oldest - 1}..${latest}); run a full scan`)
      return { ...gone, body: { ...(gone.body as object), latest } }
    }
    const events = this.state.changes.filter((e) => e.seq > since).slice(0, Math.min(limit, 1000))
    return { status: 200, body: { events, next: events.length > 0 ? events[events.length - 1].seq : since, latest } }
  }

  /** Log Analytics has its own per-principal query quota, independent of ARM's subscription limits. */
  queryLogs(resourceIds: string[], days: number, principal = 'anonymous'): SimResponse {
    const wait = this.throttle(`logs:${principal}`, { capacity: this.faults.logQueryCapacity, refillPerSec: this.faults.logQueryRefillPerSec })
    if (wait > 0) {
      this.stats.throttledLogs++
      return error(429, 'TooManyRequests', 'Log Analytics query rate exceeded', { 'Retry-After': String(Math.max(1, Math.ceil(wait / 1000))) })
    }
    const now = this.clock()
    const rows: LogRow[] = []
    for (const id of resourceIds.slice(0, 200)) {
      const a = this.account(id)
      if (a) rows.push(...logRows(a, days, now))
    }
    const columns = ['_ResourceId', 'AuthenticationType', 'CallerIpAddress', 'UserAgentHeader', 'TlsVersion', 'Protocol', 'Requests', 'Failed', 'LastSeen']
    return {
      status: 200,
      body: { tables: [{ name: 'PrimaryResult', columns: columns.map((name) => ({ name })), rows: rows.map((r) => [r.resourceId, r.authType, r.callerIp, r.userAgent, r.tlsVersion, r.protocol, r.requests, r.failed, r.lastSeen]) }] },
    }
  }

  metrics(path: string, from: number, to: number): SimResponse {
    const parsed = parseSimPath(path)
    const a = parsed ? this.account(parsed.accountId) : undefined
    if (!a) return error(404, 'ResourceNotFound', 'Storage account not found')
    const end = Math.min(to, this.clock())
    const points = transactionSeries(a, Math.max(from, end - 30 * 60_000), end)
    const series = (value: string, pick: (p: (typeof points)[number]) => number) => ({
      metadatavalues: [{ name: { value: 'responsetype' }, value }],
      data: points.map((p) => ({ timeStamp: p.timeStamp, total: pick(p) })),
    })
    return {
      status: 200,
      body: { value: [{ name: { value: 'Transactions' }, unit: 'Count', timeseries: [series('Success', (p) => p.success), series('AuthorizationError', (p) => p.authorizationError)] }] },
    }
  }

  setPolicy(controlId: string, effect: PolicyEffect | null): SimResponse {
    if (!CONTROLS.some((c) => c.id === controlId)) return error(404, 'PolicyDefinitionNotFound', `Unknown control ${controlId}`)
    if (effect) this.state.policies[controlId] = effect
    else delete this.state.policies[controlId]
    this.dirty = true
    return { status: 200, body: { controlId, effect } }
  }

  /** A team deploying from an old template: insecure defaults, subject to policy. */
  createFromTemplate(rng = mulberry32(Math.floor(this.random() * 1e9))): { status: 'created' | 'denied'; id?: string; modified: string[]; reason?: string } {
    const sub = this.state.subscriptions[Math.floor(rng() * this.state.subscriptions.length)]
    const team = sub.tags.owner
    const name = `st${team.replace(/[^a-z]/g, '').slice(0, 6)}new${Math.floor(rng() * 1e8).toString(36)}`.slice(0, 24)
    const id = accountResourceId(sub.subscriptionId, `rg-${team}-drift`, name)
    const template: AccountProperties = {
      allowBlobPublicAccess: true,
      allowSharedKeyAccess: true,
      minimumTlsVersion: 'TLS1_0',
      supportsHttpsTrafficOnly: true,
      publicNetworkAccess: 'Enabled',
      networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices', ipRules: [] },
    }
    const result = this.applyPolicy(template, {}, true)
    if (result.denied) {
      this.stats.deniedByPolicy++
      return { status: 'denied', modified: [], reason: result.denied }
    }
    const now = this.clock()
    const ts = new Date(now).toISOString()
    const tags = { owner: team, env: sub.tags.env, app: 'drift', dataClassification: 'internal' }
    const dine = (control: string) => this.state.policies[control] === 'deployIfNotExists'
    const a: SimAccount = {
      id,
      subscriptionId: sub.subscriptionId,
      resourceGroup: `rg-${team}-drift`,
      name,
      location: 'eastus',
      tags,
      createdAt: ts,
      account: { props: result.props!, etag: etagFor(1, this.random), version: 1, lastModifiedAt: ts },
      blobService: { props: { deleteRetentionPolicy: dine('SA-06') ? { enabled: true, days: 7 } : { enabled: false } }, etag: etagFor(1, this.random), version: 1, lastModifiedAt: ts },
      diagnostics: {
        props: dine('SA-07') ? { enabled: true, workspaceId: WORKSPACE_ID, categories: ['StorageRead', 'StorageWrite', 'StorageDelete'], createdAt: ts } : { enabled: false, workspaceId: null, categories: [], createdAt: null },
        etag: etagFor(1, this.random),
        version: 1,
        lastModifiedAt: ts,
      },
      graph: { current: { props: result.props!, tags, lastModifiedAt: ts }, pending: [] },
      clients: [],
    }
    // Not visible in Resource Graph until the lag passes.
    a.graph.pending.push({ visibleAt: now + this.faults.graphLagMs, view: a.graph.current })
    this.state.accounts.push(a)
    this.index.set(id.toLowerCase(), a)
    this.recordChange(a, 'account', 'Create')
    this.dirty = true
    return { status: 'created', id, modified: [...result.modified, ...(dine('SA-06') ? ['SA-06'] : []), ...(dine('SA-07') ? ['SA-07'] : [])] }
  }

  /** Adds a caller the logs don't show (a periodic job last run 45 days ago) that breaks when its auth path goes away. */
  injectHiddenDependency(accountId: string, authType: SimClient['authType'] = 'AccountKey'): SimResponse {
    const a = this.account(accountId)
    if (!a) return error(404, 'ResourceNotFound', 'Storage account not found')
    const c: SimClient = {
      id: `${a.name}-inj${a.clients.length}`,
      app: authType === 'Anonymous' ? 'partner-catalog-sync' : 'quarter-end-close',
      authType,
      callerIp: '10.20.30.40',
      userAgent: 'AzCopy/10.21.2',
      tlsVersion: 'TLS 1.2',
      protocol: 'HTTPS',
      perMinute: 40,
      schedule: 'periodic',
      lastRunDaysAgo: 45,
      brokenIntervals: [],
    }
    a.clients.push(c)
    this.dirty = true
    return { status: 200, body: { accountId: a.id, client: c.id } }
  }

  writeCounts(ids: string[]): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {}
    for (const id of ids) {
      const a = this.account(id)
      if (!a) continue
      out[a.id] = {}
      for (const kind of ['account', 'blobService', 'diagnostics'] as const) out[a.id][kind] = this.state.writeCounts[`${a.id}|${kind}`] ?? 0
    }
    return out
  }

  summary() {
    const teams = new Set(TEAMS)
    return {
      seed: this.state.seed,
      generatedAt: this.state.generatedAt,
      subscriptions: this.state.subscriptions.length,
      accounts: this.state.accounts.filter((a) => !a.deleted).length,
      teams: teams.size,
      changeSeq: this.state.nextSeq - 1,
      policies: this.state.policies,
      faults: this.state.faults,
      stats: this.stats,
    }
  }

  save(file: string): void {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state))
    renameSync(tmp, file)
    this.dirty = false
  }

  static load(file: string): FleetState {
    return JSON.parse(readFileSync(file, 'utf8')) as FleetState
  }

  replaceState(state: FleetState): void {
    this.state = state
    this.buckets.clear()
    this.reindex()
    this.dirty = true
  }
}
