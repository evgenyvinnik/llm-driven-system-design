export type Role = 'security' | 'owner' | 'approver'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  team: string | null
}

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type EvidenceClass = 'safe_to_fix' | 'needs_owner_migration' | 'insufficient_evidence'
export type FindingStatus = 'open' | 'exempt' | 'resolved'

export interface EvidenceCounts {
  safe_to_fix: number
  needs_owner_migration: number
  insufficient_evidence: number
}

export interface ControlPosture {
  id: string
  key: string
  title: string
  severity: Severity
  kind: string
  breaking: boolean
  policyEffect: string
  total: number
  compliant: number
  open: number
  exempt: number
  compliancePct: number
  evidence: EvidenceCounts
  inRemediation: number
}

export interface PosturePoint {
  takenAt: string
  source: 'scan' | 'seed'
  open: number
  compliant: number
  total: number
  controls: Record<string, number>
}

export interface Posture {
  scope: { kind: 'fleet' } | { kind: 'team'; team: string }
  fleet: { accounts: number; subscriptions: number; openFindings: number; criticalOpen: number; exempt: number; compliancePct: number }
  controls: ControlPosture[]
  history: PosturePoint[]
  freshness: {
    lastFullScanAt: string | null
    lastFullScanMs: number | null
    lastChangeEventAt: string | null
    changeFeedPolledAt: string | null
    oldestObservationAt: string | null
    newestObservationAt: string | null
  }
}

export interface Finding {
  id: number
  accountId: string
  accountName: string
  subscriptionId: string
  subscriptionName: string
  environment: string
  owner: string | null
  ownerSource: 'tag' | 'subscription'
  dataClassification: string | null
  controlId: string
  controlTitle: string
  severity: Severity
  riskScore: number
  status: FindingStatus
  evidenceClass: EvidenceClass | null
  evidenceReason: string | null
  observed: unknown
  firstSeenAt: string
  dueAt: string | null
  reopenedCount: number
  inRemediation: boolean
}

export interface Facets {
  controls: { id: string; title: string }[]
  subscriptions: { id: string; name: string }[]
  owners: string[]
  environments: string[]
}

export interface UsageCaller {
  callerIp: string
  userAgent: string
  authType: string
  tlsVersion: string
  protocol: string
  requests: number
  lastSeen: string
}

export interface AccountDetail {
  account: {
    id: string
    name: string
    subscriptionId: string
    subscriptionName: string
    managementGroup: string
    resourceGroup: string
    location: string
    tags: Record<string, string>
    owner: string | null
    ownerSource: string
    environment: string
    dataClassification: string | null
    observedVia: string
    observedAt: string
    propertiesModifiedAt: string
    trafficPerMin: number
  }
  controls: {
    controlId: string
    title: string
    property: string
    desired: string
    current: unknown
    compliant: boolean | null
    breaking: boolean
    finding: { id: number; status: FindingStatus; severity: Severity; riskScore: number; evidenceClass: EvidenceClass | null; evidenceReason: string | null; dueAt: string | null; firstSeenAt: string; reopenedCount: number } | null
  }[]
  evidence: { computedAt: string; lookbackDays: number; windowDays: number; hasLogs: boolean; counts: Record<string, number>; callers: UsageCaller[]; stale: boolean } | null
  history: AuditEntry[]
  targets: { id: number; campaignId: string; campaignName: string; controlId: string; state: TargetState; waveNo: number; writeOutcome: string | null; appliedAt: string | null; rollbackReason: string | null; lastError: string | null }[]
  exceptions: { id: string; controlId: string; status: string; justification: string; requestedByName: string; expiresAt: string | null; createdAt: string }[]
}

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'killed'
export type TargetState = 'pending' | 'queued' | 'applying' | 'baking' | 'rolling_back' | 'verified' | 'rolled_back' | 'skipped' | 'escalated' | 'failed' | 'cancelled'

export interface TargetCounts {
  total: number
  pending: number
  queued: number
  applying: number
  baking: number
  rolling_back: number
  verified: number
  rolled_back: number
  skipped: number
  escalated: number
  failed: number
  cancelled: number
  deferred: number
  recovered: number
  reconciled: number
  throttles: number
}

export interface PlanSummary {
  eligible: number
  waves: { waveNo: number; ring: string; label: string; size: number }[]
  excluded: Record<string, number>
}

export interface CampaignConfig {
  name: string
  controlId: string
  scope: { environments?: string[]; subscriptionIds?: string[]; owners?: string[] }
  canaryPercent: number
  growthFactor: number
  maxWaveSize: number
  includeClasses: EvidenceClass[]
  bakeSeconds: number
  maxFailuresPerWave: number
}

export interface Campaign {
  id: string
  name: string
  controlId: string
  status: CampaignStatus
  statusReason: string | null
  config: CampaignConfig
  plan: PlanSummary
  selfService: boolean
  createdBy: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  counts?: TargetCounts
  currentWave?: number | null
  waveCount?: number
}

export interface Wave {
  waveNo: number
  ring: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'halted'
  targetCount: number
  startedAt: string | null
  finishedAt: string | null
  acknowledgedFailures: number
  counts: TargetCounts
}

export interface CampaignTarget {
  id: number
  accountId: string
  accountName: string
  environment: string
  waveNo: number
  state: TargetState
  attempts: number
  writeOutcome: string | null
  appliedAt: string | null
  bakeUntil: string | null
  rollbackReason: string | null
  lastError: string | null
  notBefore: string | null
  updatedAt: string
  beforeValue: unknown
  afterValue: unknown
}

export interface CampaignEvent {
  id?: string
  type: string
  accountId?: string
  waveNo?: number
  message?: string
  outcome?: string
  at: string
}

export interface CampaignSnapshot {
  campaign: Campaign
  counts: TargetCounts
  waves: Wave[]
  recent: CampaignTarget[]
  events?: CampaignEvent[]
}

export interface ExceptionRecord {
  id: string
  accountId: string
  accountName: string
  owner: string | null
  environment: string
  controlId: string
  controlTitle: string
  severity: Severity | null
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked'
  justification: string
  requestedBy: string
  requestedByName: string
  requestedDays: number
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  expiresAt: string | null
  createdAt: string
}

export interface AuditEntry {
  id: number
  at: string
  actor: string
  action: string
  accountId?: string | null
  accountName?: string | null
  controlId: string | null
  campaignId: string | null
  before: unknown
  after: unknown
  details: Record<string, unknown>
}

export interface ControlPolicy {
  id: string
  key: string
  version: number
  title: string
  description: string
  severity: Severity
  kind: string
  breaking: boolean
  property: string
  desired: string
  policyDefinition: string
  allowedEffects: string[]
  policyEffect: string
  policyUpdatedAt: string | null
  policyUpdatedBy: string | null
  compliancePct: number
  open: number
  denyReadyPct: number
}

export interface Notification {
  id: number
  kind: string
  message: string
  accountId: string | null
  controlId: string | null
  dueAt: string | null
  createdAt: string
  readAt: string | null
}
