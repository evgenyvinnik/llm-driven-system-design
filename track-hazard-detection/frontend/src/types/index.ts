export type Role = 'dispatcher' | 'inspector' | 'admin'
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type HazardKind = 'rockfall' | 'obstruction' | 'high_water' | 'rail_buckling_risk'
export type ResponseStatus = 'alerting' | 'acknowledged' | 'responding' | 'cleared' | 'false_alarm'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  deskId: string | null
}

export interface EvidenceRef {
  eventId: string
  sensorId: string
  kind: string
  milepost: number
  occurredAt: string
  confidence: number
  late: boolean
}

export interface WarnedTrain {
  trainId: string
  symbol: string
  etaMinutes: number
  distanceMiles: number
  direction: 'increasing' | 'decreasing'
  warnedAt?: string
  automatic?: boolean
  releasedAt?: string | null
}

export interface Restriction {
  restrictionId: string
  hazardId: string
  subdivisionId?: string
  mpFrom: number
  mpTo: number
  maxSpeedMph: number
  reason: string
  automatic: boolean
  issuedBy: string
  issuedAt: string
  liftedAt: string | null
  liftedBy: string | null
  active?: boolean
  liftReason?: string | null
  hazardCode?: string | null
  hazardKind?: string | null
}

export interface Hazard {
  hazardId: string
  code: string
  kind: HazardKind
  subdivisionId: string
  segmentId: string
  mpFrom: number
  mpTo: number
  confidence: number
  severity: Severity
  peakSeverity: Severity
  detectionStatus: string
  late: boolean
  open: boolean
  evidence: EvidenceRef[]
  firstEvidenceAt: string
  detectedAt: string
  trigger: { eventId: string; occurredAt: string; recordedAt: string; lane: string; late: boolean }
  heat: { band: string; railTempF: number; neutralTempF: number; projectedTempF: number } | null
  alert: {
    alertId: string
    severity: Severity
    issuedAt: string
    deskId: string
    assignee: string | null
    ackDeadlineAt: string
    escalationLevel: number
    escalationTarget: string | null
    acknowledgedAt: string | null
    acknowledgedBy: string | null
  } | null
  warnedTrains: WarnedTrain[]
  restrictions: Restriction[]
  inspector: { username: string; name: string; dispatchedAt: string; etaMinutes: number } | null
  responseStatus: ResponseStatus
  closedAt: string | null
  closedBy: string | null
  closeNote: string | null
  version: number
  lastEventAt: string
}

export interface Envelope {
  eventId: string
  type: string
  version: number
  occurredAt: string
  recordedAt: string
  streamId: string
  streamVersion: number
  partitionKey: string
  correlationId: string
  causationId: string | null
  source: string
  globalPosition?: number
  meta: Record<string, unknown>
  payload: Record<string, unknown>
}

export interface Evidence {
  eventId: string
  kind: string
  sensorId: string
  milepost: number
  occurredAt: string
  ingestedAt: string | null
  confidence: number
  late: boolean
  lane: string | null
  gateway: string | null
  schemaVersion: number | null
  explainedByTrain: string | null
  hazardId: string | null
  expired: boolean
  details: Record<string, unknown>
}

export interface Notification {
  id: number
  eventType: string
  channel: string
  recipient: string
  status: string
  attempts: number
  message: string
  createdAt: string
  deliveredAt: string | null
}

export interface HazardDetail {
  hazard: Hazard
  timeline: Envelope[]
  evidence: Evidence[]
  nearbyEvidence: Evidence[]
  notifications: Notification[]
  approachingTrains: WarnedTrain[]
  inspectors: Array<{ username: string; displayName: string }>
  window: { seconds: number; radiusMiles: number }
  serverTime: string
}

export interface Subdivision {
  id: string
  name: string
  startMp: number
  endMp: number
  deskId: string
}

export interface Segment {
  id: string
  subdivisionId: string
  startMp: number
  endMp: number
  gatewayId: string
  degraded: boolean
  gatewayCoverage: string
  watermarkLagSeconds: number | null
  lastSeenAt: string | null
}

export interface SensorView {
  id: string
  type: 'geophone' | 'slide_fence' | 'camera' | 'rail_temp' | 'water_level'
  subdivisionId: string
  segmentId: string
  milepost: number
  label: string | null
  neutralTempF: number | null
  coverage: string
  lastSeenAt: string | null
  lastValue: Record<string, unknown> | null
}

export interface Train {
  trainId: string
  symbol: string
  subdivisionId: string
  milepost: number
  direction: 'increasing' | 'decreasing'
  speedMph: number
  occurredAt: string
}

export interface Coverage {
  key: string
  scope: 'sensor' | 'gateway'
  targetId: string
  segmentId: string
  subdivisionId: string
  mpFrom: number
  mpTo: number
  status: string
  reason: string
  since: string
}

export interface Board {
  subdivisions: Subdivision[]
  segments: Segment[]
  sensors: SensorView[]
  hazards: Hazard[]
  restrictions: Restriction[]
  coverage: Coverage[]
  trains: Train[]
  kpis: {
    openCritical: number
    openHazards: number
    unacknowledged: number
    activeRestrictions: number
    degradedSegments: number
    alertP50Ms: number | null
    alertP99Ms: number | null
  }
  serverTime: string
}

export interface AlertRow {
  hazardId: string
  code: string
  kind: HazardKind
  subdivisionId: string
  mpFrom: number
  mpTo: number
  severity: Severity
  status: 'open' | 'acknowledged' | 'closed'
  alertId: string
  deskId: string
  assignee: string | null
  alertSeverity: Severity
  issuedAt: string
  ackDeadlineAt: string
  escalationLevel: number
  escalationTarget?: string
  acknowledgedAt?: string | null
  acknowledgedBy?: string | null
  inspector?: string
  inspectorName?: string
  outcome?: string
  summary: string
  late: boolean
  version: number
}

export interface Summary {
  count: number
  p50: number | null
  p95: number | null
  p99: number | null
  max: number | null
}

export interface Latency {
  budgetMs: number
  alerts: { live: Summary; late: Summary }
  stages: Record<'edgeToIngest' | 'ingestToDetect' | 'detectToAlert' | 'alertToDelivered', Summary>
  decisions: Record<'critical' | 'bulk' | 'trains', { cloud: Summary; total: Summary; late: number }>
  histogram: number[]
  samples: Array<{
    hazardId: string
    code: string | null
    kind: string | null
    severity: string | null
    lane: string
    late: boolean
    totalMs: number
    stages: Record<'edgeToIngest' | 'ingestToDetect' | 'detectToAlert' | 'alertToDelivered', number | null>
    deliveredAt: string
  }>
}

export interface GroupInfo {
  key: string
  topic: string
  partition: number
  length: number
  group: string
  lag: number | null
  pending: number
  lastDeliveredId: string
  consumers: number
}

export interface OpsOverview {
  groups: GroupInfo[]
  outbox: Array<{ lane: string; unpublished: number; oldestSeconds: number | null }>
  projections: Array<{ projection: string; lastPosition: number; eventsApplied: number; lastRecordedAt: string | null; rebuiltAt: string | null; stalenessSeconds: number; eventsAfterCheckpoint: number }>
  gateways: Array<{
    gatewayId: string
    segmentId: string
    lastSeenAt: string | null
    effectiveWatermark: string | null
    bufferedCount: number
    lastSeq: number
    batches: number
    eventsAccepted: number
    duplicates: number
    coverage: string
    silentSeconds: number | null
    watermarkLagSeconds: number | null
  }>
  rates: { edgePerSecond: number; domainPerSecond: number; lateLastMinute: number; edgeTotal: number; domainTotal: number }
  processed: Array<{ consumer: string; n: number }>
  dlq: { dead: number; total: number }
  serverTime: string
}

export interface DeadLetter {
  id: string
  key: string
  topic: string
  group: string
  messageId: string
  eventId: string
  type: string
  code: string
  permanent: boolean
  error: string
  deliveries: number
  failedAt: string
  event: Envelope | string
  status: 'dead' | 'redriven' | 'discarded'
  resolvedBy: string | null
  resolvedAt: string | null
}

export interface ReplayResult {
  projection: string
  eventsReplayed: number
  before: { rows: number; md5: string }
  after: { rows: number; md5: string }
  match: boolean
  liveStreamsBehind: number
  ms: number
}
