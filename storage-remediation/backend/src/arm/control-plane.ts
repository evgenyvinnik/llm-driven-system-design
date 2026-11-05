/**
 * The control-plane interface the scanner and executor depend on, with two
 * implementations: HTTP against the cloud simulator (or, in principle, Azure)
 * and in-process against a Fleet object (seed script and tests). Responses are
 * returned, not thrown, for the statuses callers must handle explicitly:
 * 412, 429 and 5xx.
 * @module arm/control-plane
 */
import type { PolicyEffect, ResourceKind } from '../domain/types.js'

export interface ArmResult<T = ResourceBody> {
  status: number
  etag?: string
  body: T
  /** Present on 429 (and some 503s): how long the server asked us to wait. */
  retryAfterMs?: number
}

export interface ResourceBody {
  id: string
  name: string
  location?: string
  tags?: Record<string, string>
  etag?: string
  properties: Record<string, unknown>
  systemData?: { lastModifiedAt?: string }
  error?: { code: string; message: string }
}

export interface SubscriptionInfo {
  subscriptionId: string
  displayName: string
  managementGroup: string
  tags: Record<string, string>
}

export interface GraphRow {
  id: string
  name: string
  location: string
  resourceGroup: string
  subscriptionId: string
  tags: Record<string, string>
  properties: Record<string, unknown>
  systemData: { lastModifiedAt: string }
}

export interface GraphPage {
  totalRecords: number
  count: number
  data: GraphRow[]
  $skipToken?: string
}

export interface ChangeEventDto {
  seq: number
  at: string
  resourceId: string
  subscriptionId: string
  kind: ResourceKind
  changeType: 'Create' | 'Update' | 'Delete'
}

export interface ChangesPage {
  events: ChangeEventDto[]
  next: number
  latest: number
}

export interface LogRecord {
  resourceId: string
  authType: 'Anonymous' | 'SAS' | 'AccountKey' | 'OAuth'
  callerIp: string
  userAgent: string
  tlsVersion: string
  protocol: 'HTTPS' | 'HTTP'
  requests: number
  failed: number
  lastSeen: string
}

export interface TransactionPoint {
  at: number
  success: number
  authErrors: number
}

/**
 * Management plane (ARM, Resource Graph, the Storage resource provider, policy) and
 * data-plane-adjacent services (Log Analytics queries, Azure Monitor metrics) have
 * separate limits and fail independently, so they are separate methods with
 * separate throttling in the simulator and separate concurrency in the callers.
 */
export interface ControlPlane {
  listSubscriptions(): Promise<SubscriptionInfo[]>
  queryGraph(subscriptions: string[], skipToken?: string, top?: number): Promise<ArmResult<GraphPage>>
  get(accountId: string, kind: ResourceKind): Promise<ArmResult>
  /** operationId is sent as x-ms-client-request-id so a lost response can be traced in the activity log. */
  write(accountId: string, kind: ResourceKind, body: Record<string, unknown>, ifMatch?: string, operationId?: string): Promise<ArmResult>
  changes(since: number, limit: number): Promise<ArmResult<ChangesPage>>
  /** Log Analytics (its own per-principal query quota, separate from ARM). */
  queryLogs(resourceIds: string[], days: number): Promise<ArmResult<LogRecord[]>>
  transactions(accountId: string, from: number, to: number): Promise<TransactionPoint[]>
  setPolicy(controlId: string, effect: PolicyEffect | null): Promise<ArmResult<unknown>>
}

export function parseLogTable(body: unknown): LogRecord[] {
  const table = (body as { tables?: { columns: { name: string }[]; rows: unknown[][] }[] })?.tables?.[0]
  if (!table) return []
  const idx = (name: string) => table.columns.findIndex((c) => c.name === name)
  const col = {
    resourceId: idx('_ResourceId'),
    authType: idx('AuthenticationType'),
    callerIp: idx('CallerIpAddress'),
    userAgent: idx('UserAgentHeader'),
    tlsVersion: idx('TlsVersion'),
    protocol: idx('Protocol'),
    requests: idx('Requests'),
    failed: idx('Failed'),
    lastSeen: idx('LastSeen'),
  }
  return table.rows.map((r) => ({
    resourceId: String(r[col.resourceId]),
    authType: r[col.authType] as LogRecord['authType'],
    callerIp: String(r[col.callerIp]),
    userAgent: String(r[col.userAgent]),
    tlsVersion: String(r[col.tlsVersion]),
    protocol: r[col.protocol] as LogRecord['protocol'],
    requests: Number(r[col.requests]),
    failed: Number(r[col.failed] ?? 0),
    lastSeen: String(r[col.lastSeen]),
  }))
}

export function parseTransactions(body: unknown): TransactionPoint[] {
  const series = (body as { value?: { timeseries: { metadatavalues: { value: string }[]; data: { timeStamp: string; total: number }[] }[] }[] })?.value?.[0]?.timeseries ?? []
  const byTime = new Map<string, TransactionPoint>()
  for (const s of series) {
    const type = s.metadatavalues[0]?.value
    for (const d of s.data) {
      const point = byTime.get(d.timeStamp) ?? { at: Date.parse(d.timeStamp), success: 0, authErrors: 0 }
      if (type === 'AuthorizationError') point.authErrors += d.total
      else point.success += d.total
      byTime.set(d.timeStamp, point)
    }
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at)
}
