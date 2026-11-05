/**
 * Synthesized data-plane signals: which callers a config blocks, access-log
 * rows in the shape of StorageBlobLogs, and the Transactions metric split by
 * response type. Everything is derived from each account's callers, so the
 * evidence the scanner reads and the failures the executor watches agree.
 * @module cloud-sim/traffic
 */
import { isPrivateIp } from '../domain/evidence.js'
import type { AccountProperties } from '../domain/types.js'
import type { SimAccount, SimClient } from './model.js'

const DAY = 86_400_000
/** A periodic job keeps running (and retrying) this long after it starts. */
export const PERIODIC_RUN_MS = 15 * 60_000
/** Metric granularity locally; Azure Monitor's finest is one minute. */
export const METRIC_BUCKET_MS = 5_000

/** Would this caller's requests fail under these account settings? */
export function clientBlocked(c: SimClient, p: AccountProperties): boolean {
  if ((c.authType === 'AccountKey' || c.authType === 'SAS') && !p.allowSharedKeyAccess) return true
  if (c.authType === 'Anonymous' && !p.allowBlobPublicAccess) return true
  if (p.minimumTlsVersion === 'TLS1_2' && c.tlsVersion !== 'TLS 1.2') return true
  if (p.minimumTlsVersion === 'TLS1_1' && c.tlsVersion === 'TLS 1.0') return true
  if (c.protocol === 'HTTP' && p.supportsHttpsTrafficOnly) return true
  if (!isPrivateIp(c.callerIp) && (p.publicNetworkAccess === 'Disabled' || p.networkAcls.defaultAction === 'Deny')) return true
  return false
}

export function clientRunningAt(c: SimClient, t: number): boolean {
  if (c.schedule === 'continuous') return true
  return c.firedAt !== undefined && t >= c.firedAt && t < c.firedAt + PERIODIC_RUN_MS
}

function brokenAt(c: SimClient, t: number): boolean {
  return c.brokenIntervals.some((i) => t >= i.from && (i.to === undefined || t < i.to))
}

/**
 * Re-derives broken intervals after a config change. A periodic job whose
 * dependency was just removed is scheduled to run shortly (when the fault is on).
 */
export function updateClientHealth(account: SimAccount, now: number, fireDelayMs: number | null): void {
  for (const c of account.clients) {
    const blocked = clientBlocked(c, account.account.props)
    const open = c.brokenIntervals.find((i) => i.to === undefined)
    if (blocked && !open) {
      if (c.schedule === 'periodic' && fireDelayMs !== null && (c.firedAt === undefined || now > c.firedAt + PERIODIC_RUN_MS)) {
        c.firedAt = now + fireDelayMs
      }
      c.brokenIntervals.push({ from: now })
      if (c.brokenIntervals.length > 10) c.brokenIntervals.shift()
    } else if (!blocked && open) {
      open.to = now
    }
  }
}

export interface LogRow {
  resourceId: string
  authType: string
  callerIp: string
  userAgent: string
  tlsVersion: string
  protocol: string
  requests: number
  failed: number
  lastSeen: string
}

/** Aggregated StorageBlobLogs rows for one account over the last `days`. Empty when logging is off. */
export function logRows(account: SimAccount, days: number, now: number): LogRow[] {
  const d = account.diagnostics.props
  if (!d.enabled || !d.createdAt) return []
  const loggingDays = Math.max(0, (now - Date.parse(d.createdAt)) / DAY)
  const window = Math.min(days, loggingDays)
  const rows: LogRow[] = []
  for (const c of account.clients) {
    let requests = 0
    let failed = 0
    let lastSeen = 0
    if (c.schedule === 'continuous') {
      requests = Math.round(c.perMinute * 1440 * window)
      lastSeen = now
    } else if (c.lastRunDaysAgo < window) {
      requests = c.perMinute * 120
      lastSeen = now - c.lastRunDaysAgo * DAY
    }
    if (c.schedule === 'periodic' && c.firedAt !== undefined && now >= c.firedAt) {
      const ranMs = Math.min(now, c.firedAt + PERIODIC_RUN_MS) - c.firedAt
      const current = Math.round((ranMs / 60_000) * c.perMinute)
      requests += current
      if (brokenAt(c, now) || c.brokenIntervals.some((i) => i.from >= c.firedAt!)) failed += Math.round(current / 2)
      lastSeen = Math.min(now, c.firedAt + PERIODIC_RUN_MS)
    }
    if (requests <= 0) continue
    rows.push({
      resourceId: account.id,
      authType: c.authType,
      callerIp: c.callerIp,
      userAgent: c.userAgent,
      tlsVersion: c.tlsVersion,
      protocol: c.protocol,
      requests,
      failed,
      lastSeen: new Date(lastSeen).toISOString(),
    })
  }
  return rows
}

/** Small deterministic jitter so metric series don't look flat. */
function jitter(seed: string, bucket: number): number {
  let h = 2166136261
  const s = `${seed}:${bucket}`
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return 0.75 + ((h >>> 0) % 1000) / 2000
}

export interface MetricPoint {
  timeStamp: string
  success: number
  authorizationError: number
}

/** Transactions per bucket split into Success and AuthorizationError, for [from, to). */
export function transactionSeries(account: SimAccount, from: number, to: number): MetricPoint[] {
  const points: MetricPoint[] = []
  const start = Math.floor(from / METRIC_BUCKET_MS) * METRIC_BUCKET_MS
  for (let t = start; t < to; t += METRIC_BUCKET_MS) {
    let success = 0
    let authorizationError = 0
    for (const c of account.clients) {
      if (!clientRunningAt(c, t)) continue
      const n = Math.round(((c.perMinute * METRIC_BUCKET_MS) / 60_000) * jitter(c.id, t))
      if (brokenAt(c, t)) authorizationError += Math.max(1, n)
      else success += n
    }
    points.push({ timeStamp: new Date(t).toISOString(), success, authorizationError })
  }
  return points
}
