/**
 * The simulated control plane's state: subscriptions, storage accounts (with
 * their child resources and the apps that call them), the resource change
 * feed, policy assignments and fault settings.
 * @module cloud-sim/model
 */
import type { AccountProperties, BlobServiceProperties, DiagnosticsProperties, PolicyEffect } from '../domain/types.js'

export interface SimSubscription {
  subscriptionId: string
  displayName: string
  managementGroup: string
  tags: { env: string; owner: string }
}

export type AuthType = 'Anonymous' | 'SAS' | 'AccountKey' | 'OAuth'

/** An application that calls one account. Its settings decide which configs break it. */
export interface SimClient {
  id: string
  app: string
  authType: AuthType
  callerIp: string
  userAgent: string
  tlsVersion: 'TLS 1.0' | 'TLS 1.1' | 'TLS 1.2'
  protocol: 'HTTPS' | 'HTTP'
  /** Requests per minute while running. */
  perMinute: number
  /** Periodic jobs run rarely (a quarter-end close); their last run may be outside the log window. */
  schedule: 'continuous' | 'periodic'
  lastRunDaysAgo: number
  /** Periodic jobs only: when the current run started (sim clock, ms). */
  firedAt?: number
  /** When this client was failing because of the account's config. */
  brokenIntervals: { from: number; to?: number }[]
}

export interface Versioned<T> {
  props: T
  etag: string
  version: number
  lastModifiedAt: string
}

export interface GraphView {
  props: AccountProperties
  tags: Record<string, string>
  lastModifiedAt: string
}

export interface SimAccount {
  id: string
  subscriptionId: string
  resourceGroup: string
  name: string
  location: string
  tags: Record<string, string>
  createdAt: string
  account: Versioned<AccountProperties>
  blobService: Versioned<BlobServiceProperties>
  diagnostics: Versioned<DiagnosticsProperties>
  /** What Resource Graph currently returns, and writes that are not visible there yet. */
  graph: { current: GraphView; pending: { visibleAt: number; view: GraphView }[] }
  clients: SimClient[]
  deleted?: boolean
}

export interface ChangeEvent {
  seq: number
  at: string
  resourceId: string
  subscriptionId: string
  kind: 'account' | 'blobService' | 'diagnostics'
  changeType: 'Create' | 'Update' | 'Delete'
}

export interface Faults {
  writeCapacity: number
  writeRefillPerSec: number
  readCapacity: number
  readRefillPerSec: number
  graphCapacity: number
  graphRefillPerSec: number
  /** Log Analytics query quota per principal (data-plane side, separate from ARM). */
  logQueryCapacity: number
  logQueryRefillPerSec: number
  /** Resource Graph shows a write this long after ARM accepted it. */
  graphLagMs: number
  /** Share of writes that fail with a 5xx. */
  error5xxRate: number
  /** Share of those 5xx where the write was applied anyway (outcome unknown to the caller). */
  ambiguous5xxShare: number
  /** Compresses a quarter into the bake window: a periodic job runs soon after its dependency is removed. */
  periodicJobsFireDuringBake: boolean
  periodicFireDelayMs: number
}

export const DEFAULT_FAULTS: Faults = {
  writeCapacity: 4,
  writeRefillPerSec: 0.5,
  readCapacity: 60,
  readRefillPerSec: 25,
  graphCapacity: 15,
  graphRefillPerSec: 3,
  logQueryCapacity: 10,
  logQueryRefillPerSec: 1,
  graphLagMs: 10_000,
  error5xxRate: 0.03,
  ambiguous5xxShare: 0.5,
  periodicJobsFireDuringBake: true,
  periodicFireDelayMs: 3_000,
}

export interface SimStats {
  writes: number
  reads: number
  throttledWrites: number
  throttledReads: number
  throttledGraph: number
  throttledLogs: number
  errors5xx: number
  ambiguous5xx: number
  preconditionFailed: number
  deniedByPolicy: number
}

export interface FleetState {
  seed: number
  generatedAt: string
  subscriptions: SimSubscription[]
  accounts: SimAccount[]
  changes: ChangeEvent[]
  nextSeq: number
  /** Policy assignment effect per control id (absent = not assigned). */
  policies: Record<string, PolicyEffect>
  /** Successful writes per account: the evidence that nothing was applied twice. */
  writeCounts: Record<string, number>
  faults: Faults
}
