import type { Allocation, FlagKind, FlagStatus, TargetingRule, UnitType, VariantDef } from '@exp/core'

export type Role = 'admin' | 'viewer'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
}

export interface Environment {
  key: string
  name: string
  clientKey: string
  serverKey: string | null
}

export interface FlagConfig {
  environment: string
  status: FlagStatus
  version: number
  allocation: Allocation
  weights: Record<string, number>
  rules: TargetingRule[]
  fallthrough: 'enroll' | 'exclude'
  allowedTransitions: FlagStatus[]
  startedAt: string | null
  stoppedAt: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface Flag {
  id: string
  key: string
  kind: FlagKind
  name: string
  description: string
  unitType: UnitType
  salt: string
  variants: VariantDef[]
  defaultVariant: string
  primaryMetric: string
  attributionWindowHours: number
  surface: string
  createdAt: string
  updatedAt: string
  configs: Record<string, FlagConfig>
}

export interface VersionEntry {
  version: number
  status: FlagStatus
  weights: Record<string, number>
  ruleCount: number
  fallthrough: string
  changedAt: string
  changedBy: string | null
}

export interface AuditEntry {
  id: number
  at: string
  actor: string
  action: string
  flagKey: string | null
  environment: string | null
  fromVersion: number | null
  toVersion: number | null
  summary: string
}

export interface Lift {
  controlRate: number
  treatmentRate: number
  absDiff: number
  absLow: number
  absHigh: number
  relLift: number | null
  relLow: number | null
  relHigh: number | null
  z: number
  pValue: number
  significant: boolean
}

export interface Arm {
  variant: string
  units: number
  crossovers: number
  analyzedUnits: number
  conversions: number
  rate: number
  ci: [number, number]
  observedShare: number
  expectedShare: number
  expectedUnits: number
  lift: Lift | null
}

export interface Analysis {
  totalUnits: number
  crossovers: number
  arms: Arm[]
  srm: { chi2: number; df: number; pValue: number; flagged: boolean; threshold: number } | null
}

export interface EventCounts {
  rows: number
  unique: number
  late: number
  dataThrough: string | null
}

export interface Results {
  flag: {
    key: string
    name: string
    kind: string
    unitType: UnitType
    status: FlagStatus
    version: number
    primaryMetric: string
    attributionWindowHours: number
    surface: string
    defaultVariant: string
    variants: { key: string; name: string }[]
    startedAt: string | null
    stoppedAt: string | null
  }
  environment: string
  exposed: Analysis
  assigned: Analysis
  events: { exposures: EventCounts; assignments: EventCounts; conversions: EventCounts; lateThresholdMinutes: number }
  computedAt: string
}

export interface LiveClient {
  sdkInstanceId: string
  label: string
  environment: string
  apiInstance: string
  transport: 'sse' | 'poll'
  connected: boolean
  heldVersion: number
  source: string
  connectedAt: number
  lastSeenAt: number
  lastUpdate: { version: number; latencyMs: number | null; reason: string | null; at: number } | null
}

export interface SnapshotInfo {
  version: number
  etag: string
  flagCount: number
  bytes: number
  reason: string
  createdAt: string
}

export interface ClientsView {
  environment: string
  latestVersion: number
  clients: LiveClient[]
  snapshots: SnapshotInfo[]
  servedBy: string
}

export interface SystemView {
  instanceId: string
  environments: { key: string; heldVersion: number; streamsOnThisInstance: number }[]
  worker: { id: string; at: number; lastBatchAt: number | null; rowsTotal: number; lag: number } | null
}
